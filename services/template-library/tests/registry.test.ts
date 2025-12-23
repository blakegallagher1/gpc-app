import { describe, expect, it } from "vitest";
import { getTemplate, getTemplatesByEngine } from "../src/registry.js";

describe("registry", () => {
  it("getTemplate returns correct entries", () => {
    expect(getTemplate("flex_industrial_v0")).toEqual({
      templateId: "flex_industrial_v0",
      filePath: "templates/flex_industrial_v0.xlsx",
      engineType: "excel",
      version: "0.1.0",
    });

    expect(getTemplate("deal_engine_v0")).toEqual({
      templateId: "deal_engine_v0",
      filePath: null,
      engineType: "code",
      version: "0.1.0",
    });
  });

  it("getTemplatesByEngine filters correctly", () => {
    expect(getTemplatesByEngine("excel").map((t) => t.templateId)).toEqual(["flex_industrial_v0"]);
    expect(getTemplatesByEngine("code").map((t) => t.templateId)).toEqual(["deal_engine_v0"]);
  });

  it("returns undefined for unknown template", () => {
    expect(getTemplate("unknown_template")).toBeUndefined();
  });
});
