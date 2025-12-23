import type { EngineType, TemplateEntry } from "./registry.js";
import { getTemplate } from "./registry.js";

export function routeByContractVersion(
  contractVersion: string,
): { engine: EngineType; template: TemplateEntry | null } {
  if (contractVersion === "DEAL_ENGINE_V0") {
    return { engine: "code", template: getTemplate("deal_engine_v0") ?? null };
  }

  return { engine: "excel", template: getTemplate("flex_industrial_v0") ?? null };
}

export function selectEngine(inputs: { contract?: { contract_version?: string } }): EngineType {
  const contractVersion = inputs.contract?.contract_version;
  return routeByContractVersion(contractVersion ?? "").engine;
}
