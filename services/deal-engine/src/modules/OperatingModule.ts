import { Series } from "../core/series.js";
import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

export class OperatingModule implements DealModule {
  name = "operating";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const modules = (request as { modules?: Record<string, unknown> }).modules;
    if (!modules || !Object.prototype.hasOwnProperty.call(modules, this.name)) {
      return;
    }

    ctx.addWarning(`Module ${this.name}: placeholder implementation`);
    ctx.setSeries(`${this.name}.placeholder`, Series.zeros(ctx.timeline.totalMonths));
    ctx.setMetric(`${this.name}.placeholder`, 0);
  }
}
