import { Series } from "../core/series.js";
import { Timeline } from "../core/timeline.js";
import { DealEngineInputs } from "./inputs.js";

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
  lpIrr?: number;
  gpIrr?: number;
  equityMultiple?: number;
  goingInCapRate?: number;
  exitCapRate?: number;
  averageDscr?: number;
  noiYear1?: number;
}
