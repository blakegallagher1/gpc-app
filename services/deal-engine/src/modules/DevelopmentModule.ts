import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type DevelopmentInput = {
  enabled: boolean;
  timeline?: Record<string, number>;
};

type DealEngineRequestShape = {
  modules?: {
    development?: DevelopmentInput;
  };
};

export class DevelopmentModule implements DealModule {
  name = "development";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const development = (request as DealEngineRequestShape).modules?.development;
    if (!development) {
      return;
    }

    if (development.enabled) {
      ctx.addWarning("Development module placeholder: timeline captured, no cash flow impact applied");
    }
  }
}
