import { npv as baseNpv, pmt as basePmt } from "./math-utils.js";

export function npv(rate: number, cashflows: number[]): number {
  return baseNpv(rate, cashflows);
}

export function pv(rate: number, nper: number, pmt: number, fv = 0): number {
  if (!Number.isFinite(rate)) {
    throw new TypeError("rate must be a finite number");
  }
  if (!Number.isInteger(nper) || nper <= 0) {
    throw new RangeError("nper must be a positive integer");
  }
  if (!Number.isFinite(pmt)) {
    throw new TypeError("pmt must be a finite number");
  }
  if (!Number.isFinite(fv)) {
    throw new TypeError("fv must be a finite number");
  }
  if (rate === 0) {
    return -(fv + pmt * nper);
  }

  const pow = Math.pow(1 + rate, nper);
  return -(fv + (pmt * (pow - 1)) / rate) / pow;
}

export function pmt(rate: number, nper: number, pv: number, fv = 0): number {
  return basePmt(rate, nper, pv, fv);
}
