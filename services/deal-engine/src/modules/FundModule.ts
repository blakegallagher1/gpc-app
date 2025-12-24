import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type DealEngineRequestShape = {
  modules?: {
    fund?: Record<string, unknown>;
  };
};

export class FundModule implements DealModule {
  name = "fund";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const fund = (request as DealEngineRequestShape).modules?.fund;
    if (!fund) {
      return;
    }

    ctx.addWarning("Fund module not implemented");
  }
}
