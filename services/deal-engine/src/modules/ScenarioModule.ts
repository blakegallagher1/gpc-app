import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type DealEngineRequestShape = {
  modules?: {
    scenario?: Record<string, unknown>;
  };
};

export class ScenarioModule implements DealModule {
  name = "scenario";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const scenario = (request as DealEngineRequestShape).modules?.scenario;
    if (!scenario) {
      return;
    }

    ctx.addWarning("Scenario grids not implemented in runtime");
  }
}
