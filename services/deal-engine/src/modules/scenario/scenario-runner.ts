import { irr, pmt, annualToMonthly } from "../../core/math-utils.js";
import { Series } from "../../core/series.js";
import { DealContext } from "../../types/context.js";
import {
  ScenarioInput,
  ScenarioExitCapRangeInput,
  ScenarioExitMonthRangeInput,
  ScenarioInterestRateRangeInput,
} from "../../types/inputs.js";
import { Module, ModuleResult, ValidationResult } from "../../types/module.js";
import { DebtModuleOutputs } from "../debt/debt-module.js";
import { ExitModuleOutputs } from "../exit/exit-module.js";
import { OperatingModuleOutputs } from "../operating/operating-module.js";

export interface ScenarioCell {
  exitCapRate: number;
  exitMonth: number;
  interestRate: number;
  unleveredIrr: number;
  leveredIrr: number;
  equityMultiple: number;
}

export interface ScenarioRunnerOutputs {
  baseCase: ScenarioCell;
  grid: ScenarioCell[][][];
  exitCapRates: number[];
  exitMonths: number[];
  interestRates: number[];
}

type ScenarioRunnerResult = ModuleResult<ScenarioRunnerOutputs>;

type ScenarioRangeInput =
  | ScenarioExitCapRangeInput
  | ScenarioExitMonthRangeInput
  | ScenarioInterestRateRangeInput;

function assertScenarioInput(inputs: unknown): asserts inputs is ScenarioInput | undefined {
  if (inputs === undefined) return;
  if (typeof inputs !== "object" || inputs === null) {
    throw new TypeError("scenario must be an object");
  }
  const inp = inputs as Record<string, unknown>;
  if (typeof inp.enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean");
  }
}

function isScenarioRange(value: unknown): value is ScenarioRangeInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const range = value as Record<string, unknown>;
  return (
    typeof range.low === "number" &&
    typeof range.high === "number" &&
    typeof range.step === "number"
  );
}

function buildRange(range: ScenarioRangeInput): number[] {
  const values: number[] = [];
  for (let value = range.low; value <= range.high + 1e-9; value += range.step) {
    values.push(value);
  }
  return values;
}

function calculateForwardNoi(noi: Series, exitMonth: number): number {
  if (exitMonth >= noi.length) {
    return noi.trailing12(noi.length - 1);
  }
  if (exitMonth + 12 > noi.length) {
    return noi.trailing12(Math.max(0, exitMonth - 1));
  }
  return noi.forward12(exitMonth);
}

export class ScenarioRunner implements Module<ScenarioRunnerOutputs> {
  readonly name = "scenario";
  readonly version = "0.1.0";
  readonly dependencies: readonly string[] = ["exit"];

  validate(inputs: unknown): ValidationResult {
    const errors: { path: string; message: string }[] = [];

    try {
      assertScenarioInput(inputs);
    } catch (e) {
      errors.push({ path: "scenario", message: (e as Error).message });
      return { valid: false, errors };
    }

    const scenarioInputs = inputs as ScenarioInput | undefined;

    if (scenarioInputs?.enabled) {
      if (!isScenarioRange(scenarioInputs.exit_cap_range)) {
        errors.push({
          path: "scenario.exit_cap_range",
          message: "exit_cap_range must include low, high, and step",
        });
      }
      if (!isScenarioRange(scenarioInputs.exit_month_range)) {
        errors.push({
          path: "scenario.exit_month_range",
          message: "exit_month_range must include low, high, and step",
        });
      }
      if (!isScenarioRange(scenarioInputs.interest_rate_range)) {
        errors.push({
          path: "scenario.interest_rate_range",
          message: "interest_rate_range must include low, high, and step",
        });
      }
    }

    const ranges: { path: string; value: ScenarioRangeInput | undefined }[] = [
      { path: "scenario.exit_cap_range", value: scenarioInputs?.exit_cap_range },
      { path: "scenario.exit_month_range", value: scenarioInputs?.exit_month_range },
      { path: "scenario.interest_rate_range", value: scenarioInputs?.interest_rate_range },
    ];

    for (const range of ranges) {
      if (!range.value || !isScenarioRange(range.value)) {
        continue;
      }
      if (range.value.low >= range.value.high) {
        errors.push({
          path: `${range.path}.low`,
          message: "low must be less than high",
        });
      }
      if (range.value.step <= 0) {
        errors.push({
          path: `${range.path}.step`,
          message: "step must be greater than 0",
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  compute(context: DealContext): ScenarioRunnerResult {
    const scenarioInputs = context.inputs.modules.scenario;
    const exitOutputs = context.outputs.exit as ExitModuleOutputs | undefined;
    const operatingOutputs = context.outputs.operating as OperatingModuleOutputs | undefined;
    const debtOutputs = context.outputs.debt as DebtModuleOutputs | undefined;

    if (!exitOutputs) {
      return {
        success: false,
        errors: ["ExitModule must be computed before ScenarioRunner"],
      };
    }

    if (!operatingOutputs) {
      return {
        success: false,
        errors: ["OperatingModule must be computed before ScenarioRunner"],
      };
    }

    const timeline = context.timeline;
    const exitInputs = context.inputs.modules.exit;
    const acquisitionInputs = context.inputs.modules.acquisition;
    const debtInputs = context.inputs.modules.debt;

    const baseCase: ScenarioCell = {
      exitCapRate: context.metrics.exitCapRate ?? exitInputs.exit_cap_rate,
      exitMonth: timeline.exitMonth,
      interestRate: debtInputs?.acquisition_loan.rate ?? 0,
      unleveredIrr: context.metrics.unleveredIrr ?? 0,
      leveredIrr: context.metrics.leveredIrr ?? 0,
      equityMultiple: context.metrics.equityMultiple ?? 0,
    };

    if (!scenarioInputs || scenarioInputs.enabled === false) {
      const outputs: ScenarioRunnerOutputs = {
        baseCase,
        grid: [],
        exitCapRates: [],
        exitMonths: [],
        interestRates: [],
      };
      context.outputs.scenario = outputs;
      return { success: true, outputs };
    }

    const exitCapRates = buildRange(scenarioInputs.exit_cap_range);
    const exitMonths = buildRange(scenarioInputs.exit_month_range);
    const interestRates = buildRange(scenarioInputs.interest_rate_range);

    const purchasePrice = acquisitionInputs.purchase_price;
    const closingCosts = purchasePrice * acquisitionInputs.closing_cost_pct;
    const totalAcquisitionCost = purchasePrice + closingCosts;
    const loanAmount = debtOutputs?.loanAmount ?? 0;
    const equityInvestment = totalAcquisitionCost - loanAmount;

    const noi = operatingOutputs.netOperatingIncome;
    const closeMonth = acquisitionInputs.close_month ?? 0;
    const fundingMonth = debtInputs?.funding_month ?? closeMonth;
    const debtServiceBase = debtOutputs?.totalDebtService ?? Series.zeros(timeline.totalMonths);
    const loanBalanceBase = debtOutputs?.loanBalance ?? Series.zeros(timeline.totalMonths);

    let unleveredIrrWarningSent = false;
    let leveredIrrWarningSent = false;

    const computeDebtSchedule = (rate: number): { debtService: Series; loanBalance: Series } => {
      if (!debtInputs || loanAmount <= 0) {
        const zeros = Series.zeros(timeline.totalMonths);
        return { debtService: zeros, loanBalance: zeros };
      }

      const loan = debtInputs.acquisition_loan;
      const monthlyRate = annualToMonthly(rate);
      const amortMonths = loan.amort_years * 12;
      const ioMonths = loan.io_months;
      const termMonths = loan.term_months;
      const fullPayment = -pmt(monthlyRate, amortMonths, loanAmount);

      const debtServiceValues = new Array(timeline.totalMonths).fill(0);
      const balanceValues = new Array(timeline.totalMonths).fill(0);
      let balance = loanAmount;

      for (let m = 0; m < timeline.totalMonths; m += 1) {
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
        let debtService = 0;
        let principal = 0;
        if (loanMonth < ioMonths) {
          debtService = interest;
        } else {
          debtService = fullPayment;
          principal = fullPayment - interest;
          balance -= principal;
        }

        debtServiceValues[m] = debtService;
        balanceValues[m] = Math.max(0, balance);
      }

      return { debtService: new Series(debtServiceValues), loanBalance: new Series(balanceValues) };
    };

    const computeCell = (
      exitCapRate: number,
      exitMonthValue: number,
      interestRate: number,
      debtService: Series,
      loanBalance: Series,
    ): ScenarioCell => {
      const exitMonthIndex = Math.min(
        timeline.totalMonths,
        Math.max(1, Math.round(exitMonthValue)),
      );
      const forwardNoi = calculateForwardNoi(noi, exitMonthIndex);

      const grossSalePrice = forwardNoi / exitCapRate;
      const saleCosts = grossSalePrice * exitInputs.sale_cost_pct;
      const netSaleProceeds = grossSalePrice - saleCosts;

      const loanPayoff = loanBalance.get(Math.max(0, exitMonthIndex - 1));
      const netEquityProceeds = netSaleProceeds - loanPayoff;

      const unleveredCashflows: number[] = [-totalAcquisitionCost];
      for (let m = 0; m < exitMonthIndex; m += 1) {
        unleveredCashflows.push(noi.get(m));
      }
      if (exitMonthIndex > 0) {
        unleveredCashflows[exitMonthIndex] += netSaleProceeds;
      }

      const leveredCashflows: number[] = [-equityInvestment];
      for (let m = 0; m < exitMonthIndex; m += 1) {
        leveredCashflows.push(noi.get(m) - debtService.get(m));
      }
      if (exitMonthIndex > 0) {
        leveredCashflows[exitMonthIndex] += netEquityProceeds;
      }

      let unleveredIrr = 0;
      let leveredIrr = 0;

      try {
        unleveredIrr = irr(unleveredCashflows) * 12;
      } catch {
        if (!unleveredIrrWarningSent) {
          context.warnings.push("Could not calculate unlevered IRR for scenario grid");
          unleveredIrrWarningSent = true;
        }
      }

      try {
        leveredIrr = irr(leveredCashflows) * 12;
      } catch {
        if (!leveredIrrWarningSent) {
          context.warnings.push("Could not calculate levered IRR for scenario grid");
          leveredIrrWarningSent = true;
        }
      }

      const totalCashReceived = leveredCashflows.slice(1).reduce((sum, cf) => sum + cf, 0);
      const equityMultiple = equityInvestment > 0 ? totalCashReceived / equityInvestment : 0;

      return {
        exitCapRate,
        exitMonth: exitMonthValue,
        interestRate,
        unleveredIrr,
        leveredIrr,
        equityMultiple,
      };
    };

    const grid: ScenarioCell[][][] = exitCapRates.map((exitCapRate) => {
      return exitMonths.map((exitMonth) => {
        return interestRates.map((interestRate) => {
          if (!debtInputs) {
            return computeCell(exitCapRate, exitMonth, interestRate, debtServiceBase, loanBalanceBase);
          }
          const { debtService, loanBalance } = computeDebtSchedule(interestRate);
          return computeCell(exitCapRate, exitMonth, interestRate, debtService, loanBalance);
        });
      });
    });

    const outputs: ScenarioRunnerOutputs = {
      baseCase,
      grid,
      exitCapRates,
      exitMonths,
      interestRates,
    };

    context.outputs.scenario = outputs;

    return { success: true, outputs };
  }
}
