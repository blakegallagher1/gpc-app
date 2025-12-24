import { irr } from "../core/math-utils.js";
import { Series } from "../core/series.js";
import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type ExitInput = {
  exit_month: number;
  exit_cap_rate: number;
  sale_cost_pct: number;
  forward_noi_months: number;
};

type DealEngineRequestShape = {
  acquisition?: {
    purchase_price?: number;
    closing_cost_pct?: number;
    closing_cost_fixed?: number;
  };
  modules?: {
    exit?: ExitInput;
  };
};

export class ExitModule implements DealModule {
  name = "exit";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const exit = (request as DealEngineRequestShape).modules?.exit;
    if (!exit) {
      return;
    }

    const totalMonths = ctx.timeline.totalMonths;
    const noi = ctx.getSeries("noi") ?? Series.zeros(totalMonths);
    const debtService = ctx.getSeries("debt_service") ?? Series.zeros(totalMonths);
    const loanBalance = ctx.getSeries("loan_balance") ?? Series.zeros(totalMonths);

    const exitMonth = Math.min(Math.max(exit.exit_month, 0), totalMonths - 1);
    const forwardMonths = Math.max(exit.forward_noi_months, 1);
    const availableMonths = Math.max(1, Math.min(totalMonths - exitMonth, forwardMonths));
    const forwardNoi = noi.sumRange(exitMonth, exitMonth + availableMonths);
    const annualizedNoi = forwardNoi * (12 / availableMonths);

    const grossSalePrice = exit.exit_cap_rate > 0 ? annualizedNoi / exit.exit_cap_rate : 0;
    const saleCosts = grossSalePrice * exit.sale_cost_pct;
    const netSaleProceeds = grossSalePrice - saleCosts;

    const debtPayoff = loanBalance.get(exitMonth);
    const netEquityProceeds = netSaleProceeds - debtPayoff;

    const acquisition = (request as DealEngineRequestShape).acquisition;
    const purchasePrice = acquisition?.purchase_price ?? 0;
    const closingCostPct = acquisition?.closing_cost_pct ?? 0;
    const closingCostFixed = acquisition?.closing_cost_fixed ?? 0;
    const acquisitionCost = purchasePrice + purchasePrice * closingCostPct + closingCostFixed;

    const loanAmount = ctx.getMetric("loan_amount") ?? 0;
    const originationFee = ctx.getMetric("origination_fee") ?? 0;
    const equityInvested = Math.max(acquisitionCost - loanAmount + originationFee, 0);

    const unleveredCashflows = new Array<number>(totalMonths).fill(0);
    const leveredCashflows = new Array<number>(totalMonths).fill(0);

    unleveredCashflows[0] = -acquisitionCost;
    leveredCashflows[0] = -equityInvested;

    for (let month = 1; month <= exitMonth; month += 1) {
      const noiValue = noi.get(month);
      unleveredCashflows[month] = noiValue;
      leveredCashflows[month] = noiValue - debtService.get(month);
    }

    unleveredCashflows[exitMonth] += netSaleProceeds;
    leveredCashflows[exitMonth] += netEquityProceeds;

    ctx.setSeries("unlevered_cashflow", unleveredCashflows);
    ctx.setSeries("levered_cashflow", leveredCashflows);

    const unleveredIrr = this.safeIrr(unleveredCashflows);
    const leveredIrr = this.safeIrr(leveredCashflows);

    const equityMultiple = equityInvested > 0
      ? leveredCashflows.filter((value) => value > 0).reduce((sum, value) => sum + value, 0) / equityInvested
      : 0;

    ctx.setMetric("exit_value", grossSalePrice);
    ctx.setMetric("net_sale_proceeds", netSaleProceeds);
    ctx.setMetric("unlevered_irr", unleveredIrr);
    ctx.setMetric("levered_irr", leveredIrr);
    ctx.setMetric("equity_multiple", equityMultiple);
  }

  private safeIrr(cashflows: number[]): number {
    try {
      return irr(cashflows) * 12;
    } catch {
      return 0;
    }
  }
}
