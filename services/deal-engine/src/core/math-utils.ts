function assertFiniteNumber(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function assertCashflows(cashflows: number[]): void {
  if (!Array.isArray(cashflows) || cashflows.length < 2) {
    throw new TypeError("cashflows must be an array with at least 2 entries");
  }

  let hasPositive = false;
  let hasNegative = false;
  for (let i = 0; i < cashflows.length; i += 1) {
    const value = cashflows[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`cashflows[${i}] must be a finite number`);
    }
    if (value > 0) {
      hasPositive = true;
    }
    if (value < 0) {
      hasNegative = true;
    }
  }

  if (!hasPositive || !hasNegative) {
    throw new Error("cashflows must include at least one positive and one negative value");
  }
}

function assertRate(rate: number, name: string): void {
  assertFiniteNumber(rate, name);
  if (rate <= -1) {
    throw new RangeError(`${name} must be greater than -1`);
  }
}

function sign(value: number): -1 | 0 | 1 {
  if (Number.isNaN(value)) {
    throw new Error("Computation produced NaN");
  }
  if (value === 0) {
    return 0;
  }
  return value > 0 ? 1 : -1;
}

function brentRoot(
  f: (rate: number) => number,
  a: number,
  b: number,
  tolerance: number,
  maxIterations: number,
): number {
  let fa = f(a);
  let fb = f(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (sign(fa) === sign(fb)) {
    throw new Error("Root must be bracketed for Brent's method");
  }

  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    if (sign(fb) === sign(fc)) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }

    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }

    const tol1 = 2 * Number.EPSILON * Math.abs(b) + tolerance;
    const xm = (c - b) / 2;

    if (Math.abs(xm) <= tol1 || fb === 0) {
      return b;
    }

    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      // Attempt inverse quadratic interpolation
      let s = fb / fa;
      let p: number;
      let q: number;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const q1 = fa / fc;
        const r = fb / fc;
        p = s * (2 * xm * q1 * (q1 - r) - (b - a) * (r - 1));
        q = (q1 - 1) * (r - 1) * (s - 1);
      }

      if (p > 0) {
        q = -q;
      }
      p = Math.abs(p);

      const min1 = 3 * xm * q - Math.abs(tol1 * q);
      const min2 = Math.abs(e * q);
      if (2 * p < (min1 < min2 ? min1 : min2)) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }

    a = b;
    fa = fb;
    if (Math.abs(d) > tol1) {
      b += d;
    } else {
      b += xm > 0 ? tol1 : -tol1;
    }
    fb = f(b);
  }

  return b;
}

function solveRate(
  f: (rate: number) => number,
  fPrime: (rate: number) => number,
  guess: number,
): number {
  const minRate = -0.99;
  const maxRate = 10.0;
  const tolerance = 1e-10;
  const maxNewtonIterations = 50;
  const maxBisectionIterations = 200;
  const maxBrentIterations = 200;

  let rate = guess;
  if (!Number.isFinite(rate)) {
    throw new TypeError("guess must be a finite number");
  }

  // Newton-Raphson
  for (let i = 0; i < maxNewtonIterations; i += 1) {
    if (rate <= minRate) {
      rate = minRate;
    } else if (rate >= maxRate) {
      rate = maxRate;
    }

    const value = f(rate);
    if (Math.abs(value) < tolerance) {
      return rate;
    }

    const derivative = fPrime(rate);
    if (!Number.isFinite(derivative) || derivative === 0) {
      break;
    }

    const next = rate - value / derivative;
    if (!Number.isFinite(next)) {
      break;
    }

    if (Math.abs(next - rate) < tolerance) {
      return next;
    }
    rate = next;
  }

  // Bracket + Brent/bisection fallback
  let low = minRate;
  let high = maxRate;
  let fLow = f(low);
  if (fLow === 0) {
    return low;
  }
  let fHigh = f(high);
  if (fHigh === 0) {
    return high;
  }

  let sLow = sign(fLow);
  let sHigh = sign(fHigh);

  if (sLow === sHigh) {
    // Try to find a bracket by scanning
    const steps = 200;
    let prevRate = minRate;
    let prevValue = fLow;
    for (let i = 1; i <= steps; i += 1) {
      const rateStep = minRate + (maxRate - minRate) * (i / steps);
      const value = f(rateStep);
      if (value === 0) {
        return rateStep;
      }
      if (sign(prevValue) !== sign(value)) {
        low = prevRate;
        high = rateStep;
        fLow = prevValue;
        fHigh = value;
        sLow = sign(fLow);
        sHigh = sign(fHigh);
        break;
      }
      prevRate = rateStep;
      prevValue = value;
    }
  }

  if (sLow === sHigh) {
    throw new Error("IRR could not be bracketed");
  }

  try {
    return brentRoot(f, low, high, tolerance, maxBrentIterations);
  } catch {
    // Fall back to bisection if Brent fails
  }

  for (let i = 0; i < maxBisectionIterations; i += 1) {
    const mid = (low + high) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < tolerance) {
      return mid;
    }

    const sMid = sign(fMid);
    if (sMid === sLow) {
      low = mid;
      fLow = fMid;
      sLow = sMid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

// Payment function (like Excel PMT)
// Returns monthly payment for a loan
export function pmt(
  rate: number,
  nper: number,
  pv: number,
  fv = 0,
  type: 0 | 1 = 0,
): number {
  assertFiniteNumber(rate, "rate");
  assertFiniteNumber(pv, "pv");
  assertFiniteNumber(fv, "fv");

  if (!Number.isInteger(nper) || nper <= 0) {
    throw new RangeError("nper must be a positive integer");
  }
  if (type !== 0 && type !== 1) {
    throw new RangeError("type must be 0 or 1");
  }
  if (rate <= -1) {
    throw new RangeError("rate must be greater than -1");
  }

  if (rate === 0) {
    return -(pv + fv) / nper;
  }

  const pow = Math.pow(1 + rate, nper);
  return -(rate * (fv + pv * pow)) / ((1 + rate * type) * (pow - 1));
}

// Internal rate of return for regular periods
export function irr(cashflows: number[], guess = 0.1): number {
  assertCashflows(cashflows);
  assertFiniteNumber(guess, "guess");

  const f = (rate: number) => npv(rate, cashflows);
  const fPrime = (rate: number) => {
    assertRate(rate, "rate");

    const r1 = 1 + rate;
    let denom = r1 * r1; // (1+r)^(t+1) when t=1
    let total = 0;
    for (let t = 1; t < cashflows.length; t += 1) {
      const cf = cashflows[t] ?? 0;
      total += (-t * cf) / denom;
      denom *= r1;
    }
    return total;
  };

  const guesses = [guess, 0.1, 0.2, 0.05, -0.5, 0.5, 1, 2, 5, 10];
  const errors: string[] = [];
  for (const g of guesses) {
    try {
      return solveRate(f, fPrime, g);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  throw new Error(errors[errors.length - 1] ?? "IRR could not be solved");
}

// Extended IRR for irregular periods (uses dates)
export function xirr(cashflows: number[], dates: Date[], guess = 0.1): number {
  if (!Array.isArray(dates) || dates.length < 2) {
    throw new TypeError("dates must be an array with at least 2 entries");
  }
  if (cashflows.length !== dates.length) {
    throw new Error("cashflows and dates must have the same length");
  }
  assertCashflows(cashflows);
  assertFiniteNumber(guess, "guess");

  const t0 = dates[0]?.getTime();
  if (t0 === undefined || Number.isNaN(t0)) {
    throw new Error("dates[0] must be a valid Date");
  }

  const yearFractions = dates.map((date, index) => {
    const ms = date.getTime();
    if (Number.isNaN(ms)) {
      throw new Error(`dates[${index}] must be a valid Date`);
    }
    return (ms - t0) / (365 * 24 * 60 * 60 * 1000);
  });

  const f = (rate: number) => {
    assertRate(rate, "rate");
    const r1 = 1 + rate;

    let total = 0;
    for (let i = 0; i < cashflows.length; i += 1) {
      const cf = cashflows[i] ?? 0;
      const t = yearFractions[i] ?? 0;
      total += cf / Math.pow(r1, t);
    }
    return total;
  };

  const fPrime = (rate: number) => {
    assertRate(rate, "rate");
    const r1 = 1 + rate;

    let total = 0;
    for (let i = 0; i < cashflows.length; i += 1) {
      const cf = cashflows[i] ?? 0;
      const t = yearFractions[i] ?? 0;
      total += (-t * cf) / Math.pow(r1, t + 1);
    }
    return total;
  };

  return solveRate(f, fPrime, guess);
}

// Net present value
export function npv(rate: number, cashflows: number[]): number {
  assertRate(rate, "rate");
  if (!Array.isArray(cashflows)) {
    throw new TypeError("cashflows must be an array");
  }
  for (let i = 0; i < cashflows.length; i += 1) {
    const value = cashflows[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`cashflows[${i}] must be a finite number`);
    }
  }

  const r1 = 1 + rate;
  let discount = 1;
  let total = 0;
  for (let t = 0; t < cashflows.length; t += 1) {
    if (t > 0) {
      discount *= r1;
    }
    total += (cashflows[t] ?? 0) / discount;
  }
  return total;
}

// Convert annual rate to monthly
export function annualToMonthly(annualRate: number): number {
  assertRate(annualRate, "annualRate");
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

// Convert monthly rate to annual
export function monthlyToAnnual(monthlyRate: number): number {
  assertRate(monthlyRate, "monthlyRate");
  return Math.pow(1 + monthlyRate, 12) - 1;
}
