import { Timeline } from "../core/timeline.js";
import { validateRequest } from "../validate/validate.js";
import { CapexModule } from "../modules/CapexModule.js";
import { DebtModule } from "../modules/DebtModule.js";
import { DevelopmentModule } from "../modules/DevelopmentModule.js";
import { EquityModule } from "../modules/EquityModule.js";
import { ExitModule } from "../modules/ExitModule.js";
import { FundModule } from "../modules/FundModule.js";
import { LeaseModule } from "../modules/LeaseModule.js";
import { OperatingModule } from "../modules/OperatingModule.js";
import { PortfolioModule } from "../modules/PortfolioModule.js";
import { ScenarioModule } from "../modules/ScenarioModule.js";
import { DealContext } from "./context.js";
import type { DealEngineRequestV0, DealEngineResult, DealEngineValidation, DealModule } from "./types.js";

type ContractInput = { time_step?: "monthly" | "quarterly" | "annual" };
type DealInput = {
  analysis_start_date?: string;
  hold_period_months?: number;
  hold_period_quarters?: number;
  hold_period_years?: number;
};

type DealEngineRequestShape = {
  contract?: ContractInput;
  deal?: DealInput;
  modules?: Record<string, unknown>;
};

export class DealEngineRuntime {
  private readonly request: DealEngineRequestV0;
  private readonly modules: DealModule[];

  constructor(request: DealEngineRequestV0) {
    this.request = request;
    this.modules = [
      new LeaseModule(),
      new OperatingModule(),
      new CapexModule(),
      new DevelopmentModule(),
      new DebtModule(),
      new ExitModule(),
      new EquityModule(),
      new PortfolioModule(),
      new FundModule(),
      new ScenarioModule(),
    ];
  }

  validate(): DealEngineValidation {
    return validateRequest(this.request);
  }

  run(): DealEngineResult {
    const validation = this.validate();
    if (!validation.valid) {
      return {
        validation,
        warnings: [],
        metrics: {},
        series: {},
      };
    }

    const { timeline, warnings } = this.buildContext();
    const context = new DealContext(timeline);
    warnings.forEach((warning) => context.addWarning(warning));

    for (const module of this.modules) {
      module.run(context, this.request);
    }

    return {
      validation,
      warnings: context.warnings,
      metrics: context.toMetricsRecord(),
      series: context.toSeriesRecord(),
    };
  }

  private buildContext(): { timeline: Timeline; warnings: string[] } {
    const request = this.request as DealEngineRequestShape;
    const contract = request.contract ?? {};
    const deal = request.deal ?? {};

    const timeStep = contract.time_step ?? "monthly";
    const startDate = deal.analysis_start_date ?? "2026-01-01";
    const warnings: string[] = [];

    const holdPeriodMonths = this.resolveHoldPeriodMonths(timeStep, deal, warnings);

    return {
      timeline: new Timeline({ startDate, holdPeriodMonths, timeStep }),
      warnings,
    };
  }

  private resolveHoldPeriodMonths(
    timeStep: "monthly" | "quarterly" | "annual",
    deal: DealInput,
    warnings: string[],
  ): number {
    if (timeStep === "monthly" && Number.isFinite(deal.hold_period_months)) {
      return deal.hold_period_months as number;
    }
    if (timeStep === "quarterly" && Number.isFinite(deal.hold_period_quarters)) {
      return (deal.hold_period_quarters as number) * 3;
    }
    if (timeStep === "annual" && Number.isFinite(deal.hold_period_years)) {
      return (deal.hold_period_years as number) * 12;
    }

    warnings.push("Hold period missing; defaulted to 60 months.");
    return 60;
  }
}
