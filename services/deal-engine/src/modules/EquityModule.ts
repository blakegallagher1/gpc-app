import { irr } from "../core/math-utils.js";
import { Series } from "../core/series.js";
import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type EquityParty = {
  party_id: string;
  name: string;
  role: "lp" | "gp" | "partner";
  ownership_pct: number;
};

type WaterfallTier = {
  type: string;
};

type EquityInput = {
  parties: EquityParty[];
  waterfall: {
    tiers: WaterfallTier[];
  };
};

type DealEngineRequestShape = {
  modules?: {
    equity?: EquityInput;
  };
};

export class EquityModule implements DealModule {
  name = "equity";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const equity = (request as DealEngineRequestShape).modules?.equity;
    if (!equity) {
      return;
    }

    const leveredCashflows = ctx.getSeries("levered_cashflow") ?? Series.zeros(ctx.timeline.totalMonths);

    const tiers = equity.waterfall?.tiers ?? [];
    for (const tier of tiers) {
      if (["preferred_return", "catch_up", "irr_hurdle_split"].includes(tier.type)) {
        ctx.addWarning(`Waterfall tier ${tier.type} not implemented in v0, using pro-rata`);
      }
    }

    let lpIrr: number | undefined;
    let gpIrr: number | undefined;

    for (const party of equity.parties) {
      const allocations = leveredCashflows.toArray().map((value) => value * party.ownership_pct);
      const partyIrr = this.safeIrr(allocations);

      if (party.role === "lp" && lpIrr === undefined) {
        lpIrr = partyIrr;
      }
      if (party.role === "gp" && gpIrr === undefined) {
        gpIrr = partyIrr;
      }
    }

    if (lpIrr !== undefined) {
      ctx.setMetric("lp_irr", lpIrr);
    }
    if (gpIrr !== undefined) {
      ctx.setMetric("gp_irr", gpIrr);
    }
  }

  private safeIrr(cashflows: number[]): number {
    try {
      return irr(cashflows) * 12;
    } catch {
      return 0;
    }
  }
}
