import { describe, expect, it } from "vitest";
import { routeByContractVersion, selectEngine } from "../src/router.js";

describe("router", () => {
  it("routeByContractVersion with DEAL_ENGINE_V0 returns code", () => {
    const result = routeByContractVersion("DEAL_ENGINE_V0");
    expect(result.engine).toBe("code");
    expect(result.template?.templateId).toBe("deal_engine_v0");
  });

  it("routeByContractVersion with FLEX_INDUSTRIAL_V0 returns excel", () => {
    const result = routeByContractVersion("FLEX_INDUSTRIAL_V0");
    expect(result.engine).toBe("excel");
    expect(result.template?.templateId).toBe("flex_industrial_v0");
  });

  it("selectEngine handles missing and known versions", () => {
    expect(selectEngine({ contract: { contract_version: "DEAL_ENGINE_V0" } })).toBe("code");
    expect(selectEngine({ contract: { contract_version: "FLEX_INDUSTRIAL_V0" } })).toBe("excel");
    expect(selectEngine({ contract: {} })).toBe("excel");
    expect(selectEngine({})).toBe("excel");
  });
});
