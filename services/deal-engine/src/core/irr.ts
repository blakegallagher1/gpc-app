import { irr as baseIrr, xirr as baseXirr } from "./math-utils.js";

export function irr(cashflows: number[], guess?: number): number {
  return baseIrr(cashflows, guess);
}

export function xirr(
  cashflows: { date: string; amount: number }[],
  guess?: number,
): number {
  const amounts = cashflows.map((entry) => entry.amount);
  const dates = cashflows.map((entry) => new Date(entry.date));
  return baseXirr(amounts, dates, guess);
}
