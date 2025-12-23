import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import { Timeline } from "../../src/core/timeline";

describe("Timeline", () => {
  it("constructs with a valid config", () => {
    const timeline = new Timeline({ startDate: "2026-01-01", holdPeriodMonths: 24 });

    expect(timeline.startDate.toISODate()).toBe("2026-01-01");
    expect(timeline.holdPeriodMonths).toBe(24);
    expect(timeline.exitMonth).toBe(24);
    expect(timeline.endDate.toISODate()).toBe("2028-01-01");
    expect(timeline.totalMonths).toBe(24);
  });

  it("monthIndex returns expected indices for various dates", () => {
    const timeline = new Timeline({ startDate: "2026-01-01", holdPeriodMonths: 24 });

    expect(timeline.monthIndex("2026-01-01")).toBe(0);
    expect(timeline.monthIndex("2026-01-15")).toBe(0);
    expect(timeline.monthIndex("2026-02-01")).toBe(1);
    expect(timeline.monthIndex("2027-12-31")).toBe(23);
    expect(timeline.monthIndex("2028-01-01")).toBe(24);
    expect(timeline.monthIndex("2025-12-31")).toBe(-1);
  });

  it("dateAt returns expected dates for various indices", () => {
    const timeline = new Timeline({ startDate: "2026-01-01", holdPeriodMonths: 24 });

    expect(timeline.dateAt(0).toISODate()).toBe("2026-01-01");
    expect(timeline.dateAt(1).toISODate()).toBe("2026-02-01");
    expect(timeline.dateAt(23).toISODate()).toBe("2027-12-01");
  });

  it("isInPeriod returns true for dates inside the analysis period", () => {
    const timeline = new Timeline({ startDate: "2026-01-01", holdPeriodMonths: 24 });

    expect(timeline.isInPeriod("2026-01-01")).toBe(true);
    expect(timeline.isInPeriod("2026-01-31")).toBe(true);
    expect(timeline.isInPeriod("2027-12-31")).toBe(true);
  });

  it("isInPeriod returns false for dates outside the analysis period", () => {
    const timeline = new Timeline({ startDate: "2026-01-01", holdPeriodMonths: 24 });

    expect(timeline.isInPeriod("2025-12-31")).toBe(false);
    expect(timeline.isInPeriod("2028-01-01")).toBe(false);
    expect(timeline.isInPeriod("2028-01-31")).toBe(false);
  });

  it("handles edge cases (start date, end date, before/after)", () => {
    const timeline = new Timeline({ startDate: "2026-01-01", holdPeriodMonths: 24 });

    const start = DateTime.fromISO("2026-01-01", { zone: "utc" });
    const end = DateTime.fromISO("2028-01-01", { zone: "utc" });

    expect(timeline.monthIndex(start)).toBe(0);
    expect(timeline.isInPeriod(start)).toBe(true);

    expect(timeline.monthIndex(end)).toBe(24);
    expect(timeline.isInPeriod(end)).toBe(false);

    expect(timeline.isInPeriod(start.minus({ days: 1 }))).toBe(false);
    expect(timeline.isInPeriod(end.plus({ days: 1 }))).toBe(false);
  });
});

