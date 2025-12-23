import { describe, expect, it } from "vitest";

import { Series } from "../../src/core/series";

describe("Series", () => {
  it("constructs an immutable series", () => {
    const input = [1, 2, 3];
    const series = new Series(input);

    expect(series.length).toBe(3);
    expect(series.toArray()).toEqual([1, 2, 3]);

    input[0] = 999;
    expect(series.get(0)).toBe(1);

    expect(() => {
      (series.values as number[])[0] = 123;
    }).toThrow();
    expect(series.get(0)).toBe(1);
  });

  it("creates series via static factories", () => {
    expect(Series.zeros(3).toArray()).toEqual([0, 0, 0]);
    expect(Series.constant(5, 3).toArray()).toEqual([5, 5, 5]);

    const growth = Series.fromGrowth(100, 0.01, 3).toArray();
    expect(growth[0]).toBeCloseTo(100);
    expect(growth[1]).toBeCloseTo(101);
    expect(growth[2]).toBeCloseTo(102.01);
  });

  it("supports arithmetic operations and preserves immutability", () => {
    const a = new Series([1, 2, 3]);
    const b = new Series([4, 5, 6]);

    expect(a.add(b).toArray()).toEqual([5, 7, 9]);
    expect(a.add(2).toArray()).toEqual([3, 4, 5]);
    expect(a.subtract(b).toArray()).toEqual([-3, -3, -3]);
    expect(a.multiply(3).toArray()).toEqual([3, 6, 9]);
    expect(b.divide(2).toArray()).toEqual([2, 2.5, 3]);
    expect(a.negate().toArray()).toEqual([-1, -2, -3]);

    expect(a.toArray()).toEqual([1, 2, 3]);
    expect(b.toArray()).toEqual([4, 5, 6]);

    expect(() => a.add(new Series([1, 2]))).toThrow(/length mismatch/i);
  });

  it("supports aggregations (sum, sumRange, cumulative)", () => {
    const series = new Series([1, 2, 3, 4]);

    expect(series.sum()).toBe(10);
    expect(series.sumRange(1, 3)).toBe(5);
    expect(series.cumulative().toArray()).toEqual([1, 3, 6, 10]);
  });

  it("applies annual growth compounded monthly", () => {
    const base = Series.constant(100, 3);
    const annualRate = 0.12;
    const monthlyFactor = Math.pow(1 + annualRate, 1 / 12);

    const grown = base.growth(annualRate).toArray();
    expect(grown[0]).toBeCloseTo(100);
    expect(grown[1]).toBeCloseTo(100 * monthlyFactor);
    expect(grown[2]).toBeCloseTo(100 * monthlyFactor * monthlyFactor);
  });

  it("computes period aggregations (forward12, trailing12)", () => {
    const series = new Series(Array.from({ length: 24 }, (_, i) => i + 1));

    expect(series.forward12(0)).toBe(78); // 1..12
    expect(series.forward12(12)).toBe(222); // 13..24
    expect(series.forward12(20)).toBe(90); // 21..24

    expect(series.trailing12(11)).toBe(78); // 1..12
    expect(series.trailing12(23)).toBe(222); // 13..24
    expect(series.trailing12(0)).toBe(1); // 1..1
  });

  it("computes NPV using an annual discount rate compounded monthly", () => {
    const annualDiscountRate = Math.pow(1.01, 12) - 1; // equivalent to 1% monthly
    const series = new Series([-100, 110]);

    const expected = -100 + 110 / 1.01;
    expect(series.npv(annualDiscountRate)).toBeCloseTo(expected, 10);

    expect(new Series([50, 50]).npv(0)).toBe(100);
  });
});

