import { Series } from "../core/series.js";
import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type CapexItem = {
  name: string;
  month: number;
  amount: number;
  category: string;
};

type CapexInput = {
  one_time_items?: CapexItem[];
};

type DealEngineRequestShape = {
  modules?: {
    capex?: CapexInput;
  };
};

export class CapexModule implements DealModule {
  name = "capex";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const capex = (request as DealEngineRequestShape).modules?.capex;
    if (!capex) {
      return;
    }

    const totalMonths = ctx.timeline.totalMonths;
    const existing = ctx.getSeries("capex")?.toArray() ?? new Array<number>(totalMonths).fill(0);
    const values = existing.slice();

    for (const item of capex.one_time_items ?? []) {
      if (Number.isInteger(item.month) && item.month >= 0 && item.month < totalMonths) {
        values[item.month] -= item.amount;
      }
    }

    ctx.setSeries("capex", new Series(values));
  }
}
