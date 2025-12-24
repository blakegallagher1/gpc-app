import { Series } from "./series.js";

export function monthlyToAnnual(series: Series, startMonth = 0): number[] {
  if (!Number.isInteger(startMonth) || startMonth < 0) {
    throw new RangeError("startMonth must be a non-negative integer");
  }

  const totals: number[] = [];
  for (let month = startMonth; month < series.length; month += 12) {
    const end = Math.min(series.length, month + 12);
    totals.push(series.sumRange(month, end));
  }
  return totals;
}

export function monthlyToQuarterly(series: Series, startMonth = 0): number[] {
  if (!Number.isInteger(startMonth) || startMonth < 0) {
    throw new RangeError("startMonth must be a non-negative integer");
  }

  const totals: number[] = [];
  for (let month = startMonth; month < series.length; month += 3) {
    const end = Math.min(series.length, month + 3);
    totals.push(series.sumRange(month, end));
  }
  return totals;
}
