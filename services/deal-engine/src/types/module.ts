import { DealContext } from "./context";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ModuleResult<T = Record<string, unknown>> {
  success: boolean;
  outputs?: T;
  errors?: string[];
}

export interface Module<T = unknown> {
  name: string;
  version: string;
  dependencies: readonly string[];
  validate(inputs: unknown): ValidationResult;
  compute(context: DealContext): ModuleResult<T>;
}
