export type EngineType = "excel" | "code";

export interface TemplateEntry {
  templateId: string;
  filePath: string | null;
  engineType: EngineType;
  version: string;
}

export const TEMPLATE_REGISTRY: Map<string, TemplateEntry> = new Map([
  [
    "flex_industrial_v0",
    {
      templateId: "flex_industrial_v0",
      filePath: "templates/flex_industrial_v0.xlsx",
      engineType: "excel",
      version: "0.1.0",
    },
  ],
  [
    "deal_engine_v0",
    {
      templateId: "deal_engine_v0",
      filePath: null,
      engineType: "code",
      version: "0.1.0",
    },
  ],
]);

export function getTemplate(templateId: string): TemplateEntry | undefined {
  return TEMPLATE_REGISTRY.get(templateId);
}

export function getTemplatesByEngine(engine: EngineType): TemplateEntry[] {
  return Array.from(TEMPLATE_REGISTRY.values()).filter((t) => t.engineType === engine);
}
