import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type AjvValidateFunction = ((data: unknown) => boolean) & {
  errors?: { instancePath?: string; message?: string }[] | null;
};

type AjvValidator = {
  compile: (schema: unknown) => AjvValidateFunction;
  errors?: { instancePath?: string; message?: string }[] | null;
};

let validator: ((data: unknown) => boolean) | null = null;
let validatorErrors: { instancePath?: string; message?: string }[] | null = null;

function getValidator(): (data: unknown) => boolean {
  if (validator) {
    return validator;
  }

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const schemaPath = join(rootDir, "contracts", "deal_engine_v0.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;

  const AjvConstructor = Ajv2020 as unknown as new (opts: Record<string, unknown>) => AjvValidator;
  const ajv = new AjvConstructor({ strict: true, allErrors: true });
  const addFormatsPlugin = addFormats as unknown as (instance: AjvValidator) => void;
  addFormatsPlugin(ajv);

  const validate = ajv.compile(schema);
  validator = (data: unknown) => {
    const isValid = validate(data);
    validatorErrors = validate.errors ?? null;
    return Boolean(isValid);
  };

  return validator;
}

export function validateRequest(request: unknown): ValidationResult {
  try {
    const validate = getValidator();
    const valid = validate(request);
    if (valid) {
      return { valid: true, errors: [] };
    }

    const errors = (validatorErrors ?? []).map((error) => {
      const path = error.instancePath && error.instancePath.length > 0 ? error.instancePath : "/";
      const message = error.message ?? "invalid";
      return `${path}: ${message}`;
    });

    return { valid: false, errors };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Validation failed"],
    };
  }
}
