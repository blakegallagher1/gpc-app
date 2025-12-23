import { Series } from "../../core/series.js";
import { irr } from "../../core/math-utils.js";
import { DealContext } from "../../types/context.js";
import { ExitInput } from "../../types/inputs.js";
import { Module, ModuleResult, ValidationResult } from "../../types/module.js";
import { OperatingModuleOutputs } from "../operating/operating-module.js";
import { DebtModuleOutputs } from "../debt/debt-module.js";

export interface ExitModuleOutputs {
  forwardNoi: number;
  grossSalePrice: number;
  saleCosts: number;
  netSaleProceeds: number;
  loanPayoff: number;
  netEquityProceeds: number;
  unleveredCashflows: number[];
  leveredCashflows: number[];
  unleveredIrr: number;
  leveredIrr: number;
  equityMultiple: number;
}

type ExitModuleResult = ModuleResult<ExitModuleOutputs>;

function assertExitInput(inputs: unknown): asserts inputs is ExitInput {
  if (!inputs || typeof inputs !== "object") {
    throw new TypeError("exit must be an object");
  }
  const inp = inputs as Record<string, unknown>;
  if (typeof inp.exit_cap_rate !== "number") {
    throw new TypeError("exit_cap_rate must be a number");
  }
  if (typeof inp.exit_month !== "number") {
    throw new TypeError("exit_month must be a number");
  }
  if (typeof inp.sale_cost_pct !== "number") {
    throw new TypeError("sale_cost_pct must be a number");
  }
}

export class ExitModule implements Module<ExitModuleOutputs> {
  readonly name = "exit";
  readonly version = "0.1.0";
  readonly dependencies: readonly string[] = ["operating", "debt"];

  validate(inputs: unknown): ValidationResult {
    const errors: { path: string; message: string }[] = [];

    try {
      assertExitInput(inputs);
    } catch (e) {
      errors.push({ path: "exit", message: (e as Error).message });
      return { valid: false, errors };
    }

    const exitInputs = inputs as ExitInput;

    if (exitInputs.exit_cap_rate <= 0 || exitInputs.exit_cap_rate > 1) {
      errors.push({
        path: "exit.exit_cap_rate",
        message: "exit_cap_rate must be between 0 and 1",
      });
    }
    if (exitInputs.exit_month <= 0) {
      errors.push({
        path: "exit.exit_month",
        message: "exit_month must be positive",
      });
    }
    if (exitInputs.sale_cost_pct < 0 || exitInputs.sale_cost_pct > 1) {
      errors.push({
        path: "exit.sale_cost_pct",
        message: "sale_cost_pct must be between 0 and 1",
      });
    }

    return { valid: errors.length === 0, errors };
  }

  compute(context: DealContext): ExitModuleResult {
    const exitInputs = context.inputs.modules.exit;
    const acquisitionInputs = context.inputs.modules.acquisition;
    const timeline = context.timeline;
    const exitMonth = Math.min(exitInputs.exit_month, timeline.totalMonths);

    // Get module outputs
    const operatingOutputs = context.outputs.operating as OperatingModuleOutputs;
    const debtOutputs = context.outputs.debt as DebtModuleOutputs | undefined;

    if (!operatingOutputs) {
      return {
        success: false,
        errors: ["OperatingModule must be computed before ExitModule"],
      };
    }

    const noi = operatingOutputs.netOperatingIncome;

    // Calculate exit NOI for valuation
    // Use trailing 12 months if we're at the end of the timeline
    // Otherwise use forward 12 months
    let exitNoi: number;
    if (exitMonth >= noi.length) {
      // At or past the end - use trailing 12 from last available month
      exitNoi = noi.trailing12(noi.length - 1);
    } else if (exitMonth + 12 > noi.length) {
      // Partial forward data - use trailing 12 instead
      exitNoi = noi.trailing12(Math.max(0, exitMonth - 1));
    } else {
      exitNoi = noi.forward12(exitMonth);
    }
    const forwardNoi = exitNoi;

    // Calculate sale price
    const grossSalePrice = forwardNoi / exitInputs.exit_cap_rate;
    const saleCosts = grossSalePrice * exitInputs.sale_cost_pct;
    const netSaleProceeds = grossSalePrice - saleCosts;

    // Calculate loan payoff at exit
    const loanPayoff = debtOutputs
      ? debtOutputs.loanBalance.get(Math.max(0, exitMonth - 1))
      : 0;
    const netEquityProceeds = netSaleProceeds - loanPayoff;

    // Calculate total costs at acquisition
    const purchasePrice = acquisitionInputs.purchase_price;
    const closingCosts = purchasePrice * acquisitionInputs.closing_cost_pct;
    const totalAcquisitionCost = purchasePrice + closingCosts;

    // Calculate equity at acquisition
    const loanAmount = debtOutputs?.loanAmount ?? 0;
    const equityInvestment = totalAcquisitionCost - loanAmount;

    // Build unlevered cashflows
    const unleveredCashflows: number[] = [];
    unleveredCashflows.push(-totalAcquisitionCost); // Initial investment

    for (let m = 0; m < exitMonth; m++) {
      const monthlyCf = noi.get(m);
      unleveredCashflows.push(monthlyCf);
    }

    // Add sale proceeds to final month
    if (exitMonth > 0) {
      unleveredCashflows[exitMonth] += netSaleProceeds;
    }

    // Build levered cashflows
    const leveredCashflows: number[] = [];
    leveredCashflows.push(-equityInvestment); // Initial equity investment

    const debtService = debtOutputs?.totalDebtService ?? Series.zeros(timeline.totalMonths);

    for (let m = 0; m < exitMonth; m++) {
      const monthlyCf = noi.get(m) - debtService.get(m);
      leveredCashflows.push(monthlyCf);
    }

    // Add net equity proceeds to final month
    if (exitMonth > 0) {
      leveredCashflows[exitMonth] += netEquityProceeds;
    }

    // Calculate IRRs
    let unleveredIrr = 0;
    let leveredIrr = 0;

    try {
      unleveredIrr = irr(unleveredCashflows) * 12; // Annualize monthly IRR
    } catch {
      context.warnings.push("Could not calculate unlevered IRR");
    }

    try {
      leveredIrr = irr(leveredCashflows) * 12; // Annualize monthly IRR
    } catch {
      context.warnings.push("Could not calculate levered IRR");
    }

    // Calculate equity multiple
    // Equity Multiple = Total Cash Received / Total Equity Invested
    // Total Cash Received = all distributions including operating cashflow + sale proceeds
    const totalCashReceived = leveredCashflows
      .slice(1)
      .reduce((sum, cf) => sum + cf, 0);
    const equityMultiple = equityInvestment > 0 ? totalCashReceived / equityInvestment : 0;

    // Calculate going-in cap rate
    const noiYear1 = context.metrics.noiYear1 ?? 0;
    const goingInCapRate = purchasePrice > 0 ? noiYear1 / purchasePrice : 0;

    const outputs: ExitModuleOutputs = {
      forwardNoi,
      grossSalePrice,
      saleCosts,
      netSaleProceeds,
      loanPayoff,
      netEquityProceeds,
      unleveredCashflows,
      leveredCashflows,
      unleveredIrr,
      leveredIrr,
      equityMultiple,
    };

    // Update context
    context.outputs.exit = outputs;

    // Build final cashflow series (levered)
    const cashflowValues = new Array(timeline.totalMonths).fill(0);
    for (let m = 0; m < exitMonth && m < timeline.totalMonths; m++) {
      cashflowValues[m] = noi.get(m) - debtService.get(m);
    }
    if (exitMonth > 0 && exitMonth <= timeline.totalMonths) {
      cashflowValues[exitMonth - 1] += netEquityProceeds;
    }
    context.cashflows.cashFlow = new Series(cashflowValues);

    // Update metrics
    context.metrics.unleveredIrr = unleveredIrr;
    context.metrics.leveredIrr = leveredIrr;
    context.metrics.equityMultiple = equityMultiple;
    context.metrics.goingInCapRate = goingInCapRate;
    context.metrics.exitCapRate = exitInputs.exit_cap_rate;

    return { success: true, outputs };
  }
}
