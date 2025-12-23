import { describe, expect, it } from "vitest";

import { annualToMonthly, irr, monthlyToAnnual, npv, pmt } from "../../src/core/math-utils";

describe("math-utils", () => {
  it("computes PMT (matches known loan payment)", () => {
    const rate = 0.05 / 12;
    const nper = 360;
    const pv = 200_000;

    expect(pmt(rate, nper, pv)).toBeCloseTo(-1073.6432460242797, 10);
    expect(pmt(rate, nper, pv, 0, 1)).toBeCloseTo(-1069.1882947959632, 10);
  });

  it("computes IRR for regular cashflows", () => {
    expect(irr([-100, 110])).toBeCloseTo(0.1, 10);
    expect(irr([-100, 60, 60])).toBeCloseTo(0.1306623862918075, 10);
  });

  it("computes NPV for regular cashflows", () => {
    expect(npv(0.1, [-100, 110])).toBeCloseTo(0, 10);
    expect(npv(0.1, [-100, 60, 60])).toBeCloseTo(4.132231404958669, 10);
  });

  it("converts annual and monthly rates", () => {
    const annual = 0.12;
    const monthly = annualToMonthly(annual);

    expect(monthly).toBeCloseTo(0.009488792934583046, 12);
    expect(monthlyToAnnual(monthly)).toBeCloseTo(annual, 12);
  });
});

