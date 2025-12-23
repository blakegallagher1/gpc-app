import { Series } from "../core/series";
import { Timeline } from "../core/timeline";
import { DealEngineInputs } from "./inputs";

export interface DealContext {
  timeline: Timeline;
  inputs: DealEngineInputs;
  outputs: Record<string, unknown>;
  cashflows: {
    revenue: Series;
    expenses: Series;
    noi: Series;
    debtService: Series;
    cashFlow: Series;
  };
  metrics: DealMetrics;
  warnings: string[];
}

export interface DealMetrics {
  unleveredIrr?: number;
  leveredIrr?: number;
  equityMultiple?: number;
  goingInCapRate?: number;
  exitCapRate?: number;
  averageDscr?: number;
  noiYear1?: number;
}
