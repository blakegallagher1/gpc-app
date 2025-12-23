import { DealContext } from "./context";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ModuleResult {
  success: boolean;
  outputs?: Record<string, unknown>;
  errors?: string[];
}

export interface Module {
  name: string;
  version: string;
  dependencies: readonly string[];
  validate(inputs: unknown): ValidationResult;
  compute(context: DealContext): ModuleResult;
}
