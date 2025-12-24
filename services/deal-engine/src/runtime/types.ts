import type { DealContext } from "./context.js";

export type DealEngineRequestV0 = Record<string, unknown>;

export interface DealEngineValidation {
  valid: boolean;
  errors: string[];
}

export interface DealEngineResult {
  validation: DealEngineValidation;
  warnings: string[];
  metrics: Record<string, number>;
  series: Record<string, number[]>;
}

export interface DealModule {
  name: string;
  run(ctx: DealContext, request: DealEngineRequestV0): void;
}
