import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type DealEngineRequestShape = {
  modules?: {
    portfolio?: Record<string, unknown>;
  };
};

export class PortfolioModule implements DealModule {
  name = "portfolio";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const portfolio = (request as DealEngineRequestShape).modules?.portfolio;
    if (!portfolio) {
      return;
    }

    ctx.addWarning("Portfolio aggregation not implemented, using first asset only");
  }
}
