import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DealEngineRuntime } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../../testcases/deal_engine_v0/fixtures");
const expectedDir = join(__dirname, "../../../testcases/deal_engine_v0/expected");

const TOLERANCE = 1e-4;

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

function loadExpected(name: string) {
  return JSON.parse(readFileSync(join(expectedDir, name), "utf8"));
}

describe("Deal Engine V0 Regression Tests", () => {
  it("IOS_ACQ_STABILIZED_YARD_V1 produces expected metrics", () => {
    const request = loadFixture("ios_acq_stabilized_yard_v1.min.json");
    const expected = loadExpected("ios_acq_stabilized_yard_v1.expected.json");

    const engine = new DealEngineRuntime(request);
    const result = engine.run();

    expect(result.metrics.noi_year1).toBeCloseTo(expected.metrics.noi_year1, 0);
    expect(result.metrics.loan_amount).toBeCloseTo(expected.metrics.loan_amount, 0);
    expect(result.metrics.unlevered_irr).toBeCloseTo(expected.metrics.unlevered_irr, TOLERANCE);
    expect(result.metrics.levered_irr).toBeCloseTo(expected.metrics.levered_irr, TOLERANCE);
    expect(result.metrics.equity_multiple).toBeCloseTo(expected.metrics.equity_multiple, 2);
  });

  it("IND_MULTI_TENANT_VALUEADD_V1 produces expected metrics", () => {
    const request = loadFixture("ind_multi_tenant_valueadd_v1.min.json");
    const expected = loadExpected("ind_multi_tenant_valueadd_v1.expected.json");

    const engine = new DealEngineRuntime(request);
    const result = engine.run();

    expect(result.metrics.noi_year1).toBeCloseTo(expected.metrics.noi_year1, 0);
    expect(result.metrics.unlevered_irr).toBeCloseTo(expected.metrics.unlevered_irr, TOLERANCE);
    expect(result.metrics.levered_irr).toBeCloseTo(expected.metrics.levered_irr, TOLERANCE);
  });

  it("MF_DEV_MERCHANT_BUILD_V1 produces expected metrics", () => {
    const request = loadFixture("mf_dev_merchant_build_v1.min.json");
    const expected = loadExpected("mf_dev_merchant_build_v1.expected.json");

    const engine = new DealEngineRuntime(request);
    const result = engine.run();

    expect(result.metrics.noi_year1).toBeCloseTo(expected.metrics.noi_year1, 0);
    expect(result.metrics.unlevered_irr).toBeCloseTo(expected.metrics.unlevered_irr, TOLERANCE);
    expect(result.metrics.levered_irr).toBeCloseTo(expected.metrics.levered_irr, TOLERANCE);
  });
});
