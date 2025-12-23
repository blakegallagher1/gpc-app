import { Series } from "../../core/series";
import { pmt, annualToMonthly } from "../../core/math-utils";
import { DealContext } from "../../types/context";
import { DebtInput } from "../../types/inputs";
import { Module, ModuleResult, ValidationResult } from "../../types/module";

type DebtModuleResult = ModuleResult<DebtModuleOutputs>;
import { OperatingModuleOutputs } from "../operating/operating-module";

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
    const loan = debtInputs.acquisition_loan;

    // Calculate loan amount based on LTV
    const loanAmount = acquisitionPrice * loan.ltv_max;

    // Convert annual rate to monthly
    const monthlyRate = annualToMonthly(loan.rate);
    const amortMonths = loan.amort_years * 12;
    const ioMonths = loan.io_months;
    const termMonths = loan.term_months;

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

    for (let m = 0; m < totalMonths; m++) {
      if (m >= termMonths || balance <= 0) {
        // Loan is paid off or term ended
        balanceValues[m] = 0;
        continue;
      }

      // Interest for this period
      const interest = balance * monthlyRate;
      interestValues[m] = interest;

      if (m < ioMonths) {
        // Interest-only period
        debtServiceValues[m] = interest;
        principalValues[m] = 0;
      } else {
        // Amortizing period
        debtServiceValues[m] = fullPayment;
        principalValues[m] = fullPayment - interest;
        balance -= principalValues[m];
      }

      balanceValues[m] = Math.max(0, balance);

      // Calculate DSCR (annualized)
      const annualNoi = noi.forward12(m);
      const annualDebtService = debtServiceValues[m] * 12;
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
