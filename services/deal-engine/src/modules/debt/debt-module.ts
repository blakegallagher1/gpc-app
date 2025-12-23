import { Series } from "../../core/series.js";
import { pmt, annualToMonthly } from "../../core/math-utils.js";
import { DealContext } from "../../types/context.js";
import { DebtInput } from "../../types/inputs.js";
import { Module, ModuleResult, ValidationResult } from "../../types/module.js";
import { OperatingModuleOutputs } from "../operating/operating-module.js";

export interface DebtModuleOutputs {
  loanAmount: number;
  monthlyPayment: number;
  interestPayment: Series;
  principalPayment: Series;
  totalDebtService: Series;
  loanBalance: Series;
  dscr: Series;
  averageDscr: number;
}

type DebtModuleResult = ModuleResult<DebtModuleOutputs>;

function assertDebtInput(inputs: unknown): asserts inputs is DebtInput | undefined {
  if (inputs === undefined) return;
  if (typeof inputs !== "object" || inputs === null) {
    throw new TypeError("debt must be an object");
  }
  const inp = inputs as Record<string, unknown>;
  if (!inp.acquisition_loan || typeof inp.acquisition_loan !== "object") {
    throw new TypeError("acquisition_loan must be an object");
  }
}

export class DebtModule implements Module<DebtModuleOutputs> {
  readonly name = "debt";
  readonly version = "0.1.0";
  readonly dependencies: readonly string[] = ["operating"];

  validate(inputs: unknown): ValidationResult {
    const errors: { path: string; message: string }[] = [];

    try {
      assertDebtInput(inputs);
    } catch (e) {
      errors.push({ path: "debt", message: (e as Error).message });
      return { valid: false, errors };
    }

    const debtInputs = inputs as DebtInput | undefined;

    if (debtInputs) {
      const loan = debtInputs.acquisition_loan;
      if (loan.ltv_max < 0 || loan.ltv_max > 1) {
        errors.push({
          path: "debt.acquisition_loan.ltv_max",
          message: "ltv_max must be between 0 and 1",
        });
      }
      if (loan.rate < 0 || loan.rate > 1) {
        errors.push({
          path: "debt.acquisition_loan.rate",
          message: "rate must be between 0 and 1",
        });
      }
      if (loan.amort_years <= 0) {
        errors.push({
          path: "debt.acquisition_loan.amort_years",
          message: "amort_years must be positive",
        });
      }
      if (loan.io_months < 0) {
        errors.push({
          path: "debt.acquisition_loan.io_months",
          message: "io_months must be non-negative",
        });
      }
      if (
        debtInputs.sizing_mode !== undefined &&
        debtInputs.sizing_mode !== "ltv" &&
        debtInputs.sizing_mode !== "dscr" &&
        debtInputs.sizing_mode !== "explicit"
      ) {
        errors.push({
          path: "debt.sizing_mode",
          message: "sizing_mode must be ltv, dscr, or explicit",
        });
      }
      if (debtInputs.sizing_mode === "explicit") {
        if (debtInputs.explicit_loan_amount === undefined || debtInputs.explicit_loan_amount < 0) {
          errors.push({
            path: "debt.explicit_loan_amount",
            message: "explicit_loan_amount must be provided and non-negative",
          });
        }
      }
      if (debtInputs.sizing_mode === "dscr") {
        const minDscr = debtInputs.covenants?.min_dscr;
        if (minDscr === undefined || minDscr <= 0) {
          errors.push({
            path: "debt.covenants.min_dscr",
            message: "min_dscr must be provided and greater than 0 for dscr sizing",
          });
        }
      }
      if (debtInputs.funding_month !== undefined) {
        if (!Number.isInteger(debtInputs.funding_month) || debtInputs.funding_month < 0) {
          errors.push({
            path: "debt.funding_month",
            message: "funding_month must be an integer greater than or equal to 0",
          });
        }
      }
      if (debtInputs.covenants?.min_dscr !== undefined && debtInputs.covenants.min_dscr < 0) {
        errors.push({
          path: "debt.covenants.min_dscr",
          message: "min_dscr must be greater than or equal to 0",
        });
      }
      if (
        debtInputs.covenants?.cash_sweep_trigger_dscr !== undefined &&
        debtInputs.covenants.cash_sweep_trigger_dscr < 0
      ) {
        errors.push({
          path: "debt.covenants.cash_sweep_trigger_dscr",
          message: "cash_sweep_trigger_dscr must be greater than or equal to 0",
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  compute(context: DealContext): DebtModuleResult {
    const debtInputs = context.inputs.modules.debt;
    const timeline = context.timeline;
    const totalMonths = timeline.totalMonths;

    // If no debt, return zeros
    if (!debtInputs) {
      const zeros = Series.zeros(totalMonths);
      // Use a large number (999) to represent "infinite" DSCR when there's no debt
      const noDscr = Series.constant(999, totalMonths);
      const outputs: DebtModuleOutputs = {
        loanAmount: 0,
        monthlyPayment: 0,
        interestPayment: zeros,
        principalPayment: zeros,
        totalDebtService: zeros,
        loanBalance: zeros,
        dscr: noDscr,
        averageDscr: 999,
      };
      context.outputs.debt = outputs;
      context.cashflows.debtService = zeros;
      context.metrics.averageDscr = 999;
      return { success: true, outputs };
    }

    // Get operating outputs for DSCR calculation
    const operatingOutputs = context.outputs.operating as OperatingModuleOutputs;
    if (!operatingOutputs) {
      return {
        success: false,
        errors: ["OperatingModule must be computed before DebtModule"],
      };
    }

    const acquisitionPrice = context.inputs.modules.acquisition.purchase_price;
    const closeMonth = context.inputs.modules.acquisition.close_month ?? 0;
    const loan = debtInputs.acquisition_loan;

    const sizingMode = debtInputs.sizing_mode ?? "ltv";

    // Convert annual rate to monthly
    const monthlyRate = annualToMonthly(loan.rate);
    const amortMonths = loan.amort_years * 12;
    const ioMonths = loan.io_months;
    const termMonths = loan.term_months;

    const fundingMonth = debtInputs.funding_month ?? closeMonth;

    let loanAmount = 0;
    if (sizingMode === "explicit") {
      loanAmount = debtInputs.explicit_loan_amount ?? 0;
    } else if (sizingMode === "dscr") {
      const minDscr = debtInputs.covenants?.min_dscr ?? 1.25;
      const annualNoi = operatingOutputs.netOperatingIncome.forward12(fundingMonth);
      const monthlyPaymentTarget = annualNoi > 0 ? annualNoi / minDscr / 12 : 0;
      if (monthlyRate === 0) {
        loanAmount = monthlyPaymentTarget * amortMonths;
      } else {
        loanAmount =
          (monthlyPaymentTarget * (1 - Math.pow(1 + monthlyRate, -amortMonths))) / monthlyRate;
      }
    } else {
      // Calculate loan amount based on LTV
      loanAmount = acquisitionPrice * loan.ltv_max;
    }

    // Calculate fully amortizing payment
    const fullPayment = -pmt(monthlyRate, amortMonths, loanAmount);

    // Generate amortization schedule
    const interestValues = new Array(totalMonths).fill(0);
    const principalValues = new Array(totalMonths).fill(0);
    const balanceValues = new Array(totalMonths).fill(0);
    const debtServiceValues = new Array(totalMonths).fill(0);
    const dscrValues = new Array(totalMonths).fill(0);

    let balance = loanAmount;
    const noi = operatingOutputs.netOperatingIncome;
    const cashSweepTrigger = debtInputs.covenants?.cash_sweep_trigger_dscr;
    let sweepTriggered = false;

    for (let m = 0; m < totalMonths; m++) {
      if (m < fundingMonth) {
        balanceValues[m] = 0;
        continue;
      }

      const loanMonth = m - fundingMonth;
      if (loanMonth >= termMonths || balance <= 0) {
        // Loan is paid off or term ended
        balanceValues[m] = 0;
        continue;
      }

      // Interest for this period
      const interest = balance * monthlyRate;
      interestValues[m] = interest;

      let scheduledDebtService = 0;
      let principal = 0;

      if (loanMonth < ioMonths) {
        // Interest-only period
        scheduledDebtService = interest;
        principal = 0;
      } else {
        // Amortizing period
        scheduledDebtService = fullPayment;
        principal = fullPayment - interest;
        balance -= principal;
      }

      let debtService = scheduledDebtService;
      let sweepPrincipal = 0;
      if (cashSweepTrigger !== undefined && cashSweepTrigger > 0) {
        const annualNoi = noi.forward12(m);
        const annualDebtServiceScheduled = scheduledDebtService * 12;
        const dscrBeforeSweep =
          annualDebtServiceScheduled > 0 ? annualNoi / annualDebtServiceScheduled : Infinity;
        const surplusCash = noi.get(m) - scheduledDebtService;
        if (dscrBeforeSweep < cashSweepTrigger && surplusCash > 0 && balance > 0) {
          sweepPrincipal = Math.min(surplusCash, balance);
          debtService += sweepPrincipal;
          principal += sweepPrincipal;
          balance -= sweepPrincipal;
          sweepTriggered = true;
        }
      }

      principalValues[m] = principal;
      debtServiceValues[m] = debtService;
      balanceValues[m] = Math.max(0, balance);

      // Calculate DSCR (annualized)
      const annualNoi = noi.forward12(m);
      const annualDebtService = debtService * 12;
      dscrValues[m] = annualDebtService > 0 ? annualNoi / annualDebtService : Infinity;
    }

    const interestPayment = new Series(interestValues);
    const principalPayment = new Series(principalValues);
    const totalDebtService = new Series(debtServiceValues);
    const loanBalance = new Series(balanceValues);
    const dscr = new Series(dscrValues.map((v) => (Number.isFinite(v) ? v : 0)));

    // Calculate average DSCR over hold period
    const validDscr = dscrValues.filter((v) => Number.isFinite(v) && v > 0);
    const averageDscr =
      validDscr.length > 0
        ? validDscr.reduce((a, b) => a + b, 0) / validDscr.length
        : Infinity;

    const minDscr = debtInputs.covenants?.min_dscr;
    if (minDscr !== undefined && validDscr.some((value) => value < minDscr)) {
      context.warnings.push(`DSCR covenant breached (min ${minDscr.toFixed(2)}x)`);
    }
    if (sweepTriggered) {
      context.warnings.push("Cash sweep applied based on DSCR trigger");
    }

    const outputs: DebtModuleOutputs = {
      loanAmount,
      monthlyPayment: fullPayment,
      interestPayment,
      principalPayment,
      totalDebtService,
      loanBalance,
      dscr,
      averageDscr,
    };

    // Update context
    context.outputs.debt = outputs;
    context.cashflows.debtService = totalDebtService;
    context.metrics.averageDscr = averageDscr;

    return { success: true, outputs };
  }
}
