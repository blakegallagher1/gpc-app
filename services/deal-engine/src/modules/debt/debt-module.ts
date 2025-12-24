import { Series } from "../../core/series.js";
import { pmt, annualToMonthly } from "../../core/math-utils.js";
import { DealContext } from "../../types/context.js";
import { DebtInput, DebtTrancheInput, DebtTrancheType } from "../../types/inputs.js";
import { Module, ModuleResult, ValidationResult } from "../../types/module.js";
import { OperatingModuleOutputs } from "../operating/operating-module.js";

export interface TrancheOutputs {
  trancheId: string;
  trancheType: DebtTrancheType;
  loanAmount: number;
  monthlyPayment: number;
  interestPayment: Series;
  principalPayment: Series;
  debtService: Series;
  loanBalance: Series;
  pikAccrual?: Series;  // For mezz/pref with PIK
}

export interface DebtModuleOutputs {
  // Legacy single loan fields (backwards compatible)
  loanAmount: number;
  monthlyPayment: number;
  interestPayment: Series;
  principalPayment: Series;
  totalDebtService: Series;
  loanBalance: Series;
  dscr: Series;
  averageDscr: number;
  // Multi-tranche outputs
  tranches?: TrancheOutputs[];
  seniorDebt?: TrancheOutputs;
  mezzDebt?: TrancheOutputs;
  prefEquity?: TrancheOutputs;
  totalDebtAmount?: number;
  totalMezzAmount?: number;
  totalPrefEquityAmount?: number;
}

type DebtModuleResult = ModuleResult<DebtModuleOutputs>;

function assertDebtInput(inputs: unknown): asserts inputs is DebtInput | undefined {
  if (inputs === undefined) return;
  if (typeof inputs !== "object" || inputs === null) {
    throw new TypeError("debt must be an object");
  }
  const inp = inputs as Record<string, unknown>;
  // Either acquisition_loan (legacy) or tranches (multi-tranche) must be present
  const hasLegacy = inp.acquisition_loan && typeof inp.acquisition_loan === "object";
  const hasTranches = inp.tranches && Array.isArray(inp.tranches);
  if (!hasLegacy && !hasTranches) {
    throw new TypeError("Either acquisition_loan or tranches must be provided");
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
      // Validate legacy acquisition_loan if present
      const loan = debtInputs.acquisition_loan;
      if (loan) {
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

      // Validate tranches if present
      if (debtInputs.tranches) {
        for (let i = 0; i < debtInputs.tranches.length; i++) {
          const tranche = debtInputs.tranches[i];
          if (tranche.rate < 0 || tranche.rate > 1) {
            errors.push({
              path: `debt.tranches[${i}].rate`,
              message: "rate must be between 0 and 1",
            });
          }
          if (tranche.term_months <= 0) {
            errors.push({
              path: `debt.tranches[${i}].term_months`,
              message: "term_months must be positive",
            });
          }
        }
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
    const noi = operatingOutputs.netOperatingIncome;

    // Check if we have multi-tranche structure
    if (debtInputs.tranches && debtInputs.tranches.length > 0) {
      return this.computeMultiTranche(context, debtInputs, totalMonths, acquisitionPrice, closeMonth, noi);
    }

    // Legacy single loan mode
    if (!debtInputs.acquisition_loan) {
      const zeros = Series.zeros(totalMonths);
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

    return this.computeLegacySingleLoan(context, debtInputs, totalMonths, acquisitionPrice, closeMonth, noi);
  }

  private computeMultiTranche(
    context: DealContext,
    debtInputs: DebtInput,
    totalMonths: number,
    acquisitionPrice: number,
    closeMonth: number,
    noi: Series
  ): DebtModuleResult {
    const tranches = debtInputs.tranches!;
    const trancheOutputs: TrancheOutputs[] = [];

    // Initialize combined series
    let combinedInterest = Series.zeros(totalMonths);
    let combinedPrincipal = Series.zeros(totalMonths);
    let combinedDebtService = Series.zeros(totalMonths);
    let combinedBalance = Series.zeros(totalMonths);

    let totalSeniorAmount = 0;
    let totalMezzAmount = 0;
    let totalPrefEquityAmount = 0;

    let seniorDebt: TrancheOutputs | undefined;
    let mezzDebt: TrancheOutputs | undefined;
    let prefEquity: TrancheOutputs | undefined;

    // Sort tranches by seniority: senior first, then mezz, then pref_equity
    const sortedTranches = [...tranches].sort((a, b) => {
      const order = { senior: 0, mezz: 1, pref_equity: 2 };
      return (order[a.tranche_type] ?? 3) - (order[b.tranche_type] ?? 3);
    });

    for (const tranche of sortedTranches) {
      if (tranche.enabled === false) continue;

      const trancheOutput = this.computeSingleTranche(
        tranche,
        totalMonths,
        acquisitionPrice,
        closeMonth,
        noi
      );

      trancheOutputs.push(trancheOutput);

      // Add to combined totals
      combinedInterest = combinedInterest.add(trancheOutput.interestPayment);
      combinedPrincipal = combinedPrincipal.add(trancheOutput.principalPayment);
      combinedDebtService = combinedDebtService.add(trancheOutput.debtService);
      combinedBalance = combinedBalance.add(trancheOutput.loanBalance);

      // Track by type
      if (tranche.tranche_type === "senior") {
        totalSeniorAmount += trancheOutput.loanAmount;
        seniorDebt = trancheOutput;
      } else if (tranche.tranche_type === "mezz") {
        totalMezzAmount += trancheOutput.loanAmount;
        mezzDebt = trancheOutput;
      } else if (tranche.tranche_type === "pref_equity") {
        totalPrefEquityAmount += trancheOutput.loanAmount;
        prefEquity = trancheOutput;
      }
    }

    // Calculate combined DSCR
    const dscrValues = new Array(totalMonths).fill(0);
    for (let m = 0; m < totalMonths; m++) {
      const annualNoi = noi.forward12(m);
      const annualDs = combinedDebtService.get(m) * 12;
      dscrValues[m] = annualDs > 0 ? annualNoi / annualDs : 999;
    }
    const dscr = new Series(dscrValues.map((v) => (Number.isFinite(v) ? v : 999)));

    const validDscr = dscrValues.filter((v) => Number.isFinite(v) && v > 0 && v < 999);
    const averageDscr = validDscr.length > 0
      ? validDscr.reduce((a, b) => a + b, 0) / validDscr.length
      : 999;

    // Check covenants
    const minDscr = debtInputs.covenants?.min_dscr;
    if (minDscr !== undefined && validDscr.some((value) => value < minDscr)) {
      context.warnings.push(`DSCR covenant breached (min ${minDscr.toFixed(2)}x)`);
    }

    const totalLoanAmount = totalSeniorAmount + totalMezzAmount + totalPrefEquityAmount;
    const combinedMonthlyPayment = trancheOutputs.reduce((sum, t) => sum + t.monthlyPayment, 0);

    const outputs: DebtModuleOutputs = {
      loanAmount: totalLoanAmount,
      monthlyPayment: combinedMonthlyPayment,
      interestPayment: combinedInterest,
      principalPayment: combinedPrincipal,
      totalDebtService: combinedDebtService,
      loanBalance: combinedBalance,
      dscr,
      averageDscr,
      tranches: trancheOutputs,
      seniorDebt,
      mezzDebt,
      prefEquity,
      totalDebtAmount: totalSeniorAmount,
      totalMezzAmount,
      totalPrefEquityAmount,
    };

    // Update context
    context.outputs.debt = outputs;
    context.cashflows.debtService = combinedDebtService;
    context.metrics.averageDscr = averageDscr;

    // Store tranche-level series in outputs
    if (seniorDebt) {
      context.outputs.senior_debt_service = seniorDebt.debtService;
      context.outputs.senior_loan_balance = seniorDebt.loanBalance;
      context.outputs.senior_loan_amount = seniorDebt.loanAmount;
    }
    if (mezzDebt) {
      context.outputs.mezz_debt_service = mezzDebt.debtService;
      context.outputs.mezz_loan_balance = mezzDebt.loanBalance;
      context.outputs.mezz_loan_amount = mezzDebt.loanAmount;
    }
    if (prefEquity) {
      context.outputs.pref_equity_service = prefEquity.debtService;
      context.outputs.pref_equity_balance = prefEquity.loanBalance;
      context.outputs.pref_equity_amount = prefEquity.loanAmount;
    }

    return { success: true, outputs };
  }

  private computeSingleTranche(
    tranche: DebtTrancheInput,
    totalMonths: number,
    acquisitionPrice: number,
    closeMonth: number,
    noi: Series
  ): TrancheOutputs {
    const fundingMonth = tranche.funding_month ?? closeMonth;
    const monthlyRate = annualToMonthly(tranche.rate);
    const amortMonths = (tranche.amort_years ?? 0) * 12;
    const ioMonths = tranche.io_months ?? (amortMonths === 0 ? tranche.term_months : 0);
    const termMonths = tranche.term_months;
    const pikRate = tranche.pik_rate ?? 0;
    const currentPayRate = tranche.current_pay_rate ?? tranche.rate;

    // Size the tranche
    let loanAmount = 0;
    if (tranche.sizing_mode === "explicit" || tranche.explicit_amount !== undefined) {
      loanAmount = tranche.explicit_amount ?? 0;
    } else if (tranche.sizing_mode === "ltv" || tranche.ltv_max !== undefined) {
      loanAmount = acquisitionPrice * (tranche.ltv_max ?? 0);
    } else if (tranche.sizing_mode === "ltc" && tranche.ltc_max !== undefined) {
      // LTC would need total cost - for now use acquisition price
      loanAmount = acquisitionPrice * tranche.ltc_max;
    } else if (tranche.sizing_mode === "dscr" && tranche.min_dscr !== undefined) {
      const annualNoi = noi.forward12(fundingMonth);
      const monthlyPaymentTarget = annualNoi > 0 ? annualNoi / tranche.min_dscr / 12 : 0;
      if (monthlyRate === 0) {
        loanAmount = monthlyPaymentTarget * (amortMonths > 0 ? amortMonths : termMonths);
      } else {
        const periods = amortMonths > 0 ? amortMonths : termMonths;
        loanAmount = (monthlyPaymentTarget * (1 - Math.pow(1 + monthlyRate, -periods))) / monthlyRate;
      }
    }

    // Generate amortization schedule
    const interestValues = new Array(totalMonths).fill(0);
    const principalValues = new Array(totalMonths).fill(0);
    const balanceValues = new Array(totalMonths).fill(0);
    const debtServiceValues = new Array(totalMonths).fill(0);
    const pikAccrualValues = new Array(totalMonths).fill(0);

    // Calculate payment
    let fullPayment = 0;
    if (amortMonths > 0 && monthlyRate > 0) {
      fullPayment = -pmt(monthlyRate, amortMonths, loanAmount);
    } else if (amortMonths > 0) {
      fullPayment = loanAmount / amortMonths;
    }

    let balance = loanAmount;
    const monthlyCurrentPayRate = annualToMonthly(currentPayRate);
    const monthlyPikRate = annualToMonthly(pikRate);

    for (let m = 0; m < totalMonths; m++) {
      if (m < fundingMonth) {
        balanceValues[m] = 0;
        continue;
      }

      const loanMonth = m - fundingMonth;
      if (loanMonth >= termMonths || balance <= 0) {
        balanceValues[m] = 0;
        continue;
      }

      // Handle PIK (Payment-in-Kind) for mezz/pref
      if (pikRate > 0) {
        const pikInterest = balance * monthlyPikRate;
        pikAccrualValues[m] = pikInterest;
        balance += pikInterest; // PIK adds to balance
      }

      // Current pay interest
      const currentPayInterest = balance * monthlyCurrentPayRate;
      interestValues[m] = currentPayInterest;

      let scheduledDebtService = 0;
      let principal = 0;

      if (loanMonth < ioMonths || amortMonths === 0) {
        // Interest-only period
        scheduledDebtService = currentPayInterest;
        principal = 0;
      } else {
        // Amortizing period
        scheduledDebtService = fullPayment;
        principal = fullPayment - currentPayInterest;
        balance -= principal;
      }

      principalValues[m] = principal;
      debtServiceValues[m] = scheduledDebtService;
      balanceValues[m] = Math.max(0, balance);
    }

    return {
      trancheId: tranche.tranche_id,
      trancheType: tranche.tranche_type,
      loanAmount,
      monthlyPayment: fullPayment > 0 ? fullPayment : (loanAmount * monthlyCurrentPayRate),
      interestPayment: new Series(interestValues),
      principalPayment: new Series(principalValues),
      debtService: new Series(debtServiceValues),
      loanBalance: new Series(balanceValues),
      pikAccrual: pikRate > 0 ? new Series(pikAccrualValues) : undefined,
    };
  }

  private computeLegacySingleLoan(
    context: DealContext,
    debtInputs: DebtInput,
    totalMonths: number,
    acquisitionPrice: number,
    closeMonth: number,
    noi: Series
  ): DebtModuleResult {
    const loan = debtInputs.acquisition_loan!;
    const sizingMode = debtInputs.sizing_mode ?? "ltv";
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
      const annualNoi = noi.forward12(fundingMonth);
      const monthlyPaymentTarget = annualNoi > 0 ? annualNoi / minDscr / 12 : 0;
      if (monthlyRate === 0) {
        loanAmount = monthlyPaymentTarget * amortMonths;
      } else {
        loanAmount = (monthlyPaymentTarget * (1 - Math.pow(1 + monthlyRate, -amortMonths))) / monthlyRate;
      }
    } else {
      loanAmount = acquisitionPrice * loan.ltv_max;
    }

    const fullPayment = -pmt(monthlyRate, amortMonths, loanAmount);

    const interestValues = new Array(totalMonths).fill(0);
    const principalValues = new Array(totalMonths).fill(0);
    const balanceValues = new Array(totalMonths).fill(0);
    const debtServiceValues = new Array(totalMonths).fill(0);
    const dscrValues = new Array(totalMonths).fill(0);

    let balance = loanAmount;
    const cashSweepTrigger = debtInputs.covenants?.cash_sweep_trigger_dscr;
    let sweepTriggered = false;

    for (let m = 0; m < totalMonths; m++) {
      if (m < fundingMonth) {
        balanceValues[m] = 0;
        continue;
      }

      const loanMonth = m - fundingMonth;
      if (loanMonth >= termMonths || balance <= 0) {
        balanceValues[m] = 0;
        continue;
      }

      const interest = balance * monthlyRate;
      interestValues[m] = interest;

      let scheduledDebtService = 0;
      let principal = 0;

      if (loanMonth < ioMonths) {
        scheduledDebtService = interest;
        principal = 0;
      } else {
        scheduledDebtService = fullPayment;
        principal = fullPayment - interest;
        balance -= principal;
      }

      let debtService = scheduledDebtService;
      if (cashSweepTrigger !== undefined && cashSweepTrigger > 0) {
        const annualNoi = noi.forward12(m);
        const annualDebtServiceScheduled = scheduledDebtService * 12;
        const dscrBeforeSweep = annualDebtServiceScheduled > 0 ? annualNoi / annualDebtServiceScheduled : Infinity;
        const surplusCash = noi.get(m) - scheduledDebtService;
        if (dscrBeforeSweep < cashSweepTrigger && surplusCash > 0 && balance > 0) {
          const sweepPrincipal = Math.min(surplusCash, balance);
          debtService += sweepPrincipal;
          principal += sweepPrincipal;
          balance -= sweepPrincipal;
          sweepTriggered = true;
        }
      }

      principalValues[m] = principal;
      debtServiceValues[m] = debtService;
      balanceValues[m] = Math.max(0, balance);

      const annualNoi = noi.forward12(m);
      const annualDebtService = debtService * 12;
      dscrValues[m] = annualDebtService > 0 ? annualNoi / annualDebtService : Infinity;
    }

    const interestPayment = new Series(interestValues);
    const principalPayment = new Series(principalValues);
    const totalDebtService = new Series(debtServiceValues);
    const loanBalance = new Series(balanceValues);
    const dscr = new Series(dscrValues.map((v) => (Number.isFinite(v) ? v : 0)));

    const validDscr = dscrValues.filter((v) => Number.isFinite(v) && v > 0);
    const averageDscr = validDscr.length > 0 ? validDscr.reduce((a, b) => a + b, 0) / validDscr.length : Infinity;

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

    context.outputs.debt = outputs;
    context.cashflows.debtService = totalDebtService;
    context.metrics.averageDscr = averageDscr;

    return { success: true, outputs };
  }
}
