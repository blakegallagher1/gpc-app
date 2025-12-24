export class Series {
  readonly values: readonly number[];
  readonly length: number;

  constructor(values: number[] | readonly number[]);
  constructor(length: number, initialValue?: number);
  constructor(valuesOrLength: number[] | readonly number[] | number, initialValue = 0) {
    const values =
      typeof valuesOrLength === "number"
        ? Series.fromLength(valuesOrLength, initialValue)
        : valuesOrLength;

    if (!Array.isArray(values)) {
      throw new TypeError("values must be an array");
    }

    const copied = Array.from(values, (value, index) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`values[${index}] must be a finite number`);
      }
      return value;
    });

    this.values = Object.freeze(copied);
    this.length = copied.length;
  }

  static zeros(length: number): Series {
    Series.assertLength(length);
    return new Series(Array.from({ length }, () => 0));
  }

  static fromArray(arr: number[]): Series {
    return new Series(arr);
  }

  static constant(value: number, length: number): Series {
    Series.assertFiniteNumber(value, "value");
    Series.assertLength(length);
    return new Series(Array.from({ length }, () => value));
  }

  static fromGrowth(initial: number, monthlyRate: number, length: number): Series {
    Series.assertFiniteNumber(initial, "initial");
    Series.assertFiniteNumber(monthlyRate, "monthlyRate");
    if (monthlyRate <= -1) {
      throw new RangeError("monthlyRate must be greater than -1");
    }
    Series.assertLength(length);

    const factor = 1 + monthlyRate;
    return new Series(Array.from({ length }, (_, i) => initial * Math.pow(factor, i)));
  }

  get(index: number): number {
    if (!Number.isInteger(index)) {
      throw new TypeError("index must be an integer");
    }
    if (index < 0 || index >= this.length) {
      throw new RangeError(`index must be between 0 and ${Math.max(0, this.length - 1)}`);
    }
    return this.values[index] ?? 0;
  }

  set(index: number, value: number): Series {
    if (!Number.isInteger(index)) {
      throw new TypeError("index must be an integer");
    }
    if (index < 0 || index >= this.length) {
      throw new RangeError(`index must be between 0 and ${Math.max(0, this.length - 1)}`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("value must be a finite number");
    }

    const next = this.toArray();
    next[index] = value;
    return new Series(next);
  }

  slice(start: number, end?: number): Series {
    if (!Number.isInteger(start)) {
      throw new TypeError("start must be an integer");
    }
    if (end !== undefined && !Number.isInteger(end)) {
      throw new TypeError("end must be an integer");
    }
    return new Series(this.values.slice(start, end));
  }

  add(other: Series | number): Series {
    return this.elementwise(other, (a, b) => a + b);
  }

  subtract(other: Series | number): Series {
    return this.elementwise(other, (a, b) => a - b);
  }

  multiply(other: Series | number): Series {
    return this.elementwise(other, (a, b) => a * b);
  }

  divide(other: Series | number): Series {
    return this.elementwise(other, (a, b) => a / b);
  }

  negate(): Series {
    return this.map((value) => -value);
  }

  sum(): number {
    let total = 0;
    for (const value of this.values) {
      total += value;
    }
    return total;
  }

  sumRange(start: number, end: number): number {
    Series.assertIndex(start, "start");
    Series.assertIndex(end, "end");
    if (start < 0 || end < 0 || start > end || start > this.length || end > this.length) {
      throw new RangeError(`Range must satisfy 0 <= start <= end <= ${this.length}`);
    }

    let total = 0;
    for (let i = start; i < end; i += 1) {
      total += this.values[i] ?? 0;
    }
    return total;
  }

  cumulative(): Series {
    let runningTotal = 0;
    return new Series(
      this.values.map((value) => {
        runningTotal += value;
        return runningTotal;
      }),
    );
  }

  cumsum(): Series {
    return this.cumulative();
  }

  growth(annualRate: number): Series {
    Series.assertFiniteNumber(annualRate, "annualRate");
    if (annualRate <= -1) {
      throw new RangeError("annualRate must be greater than -1");
    }

    const monthlyFactor = Math.pow(1 + annualRate, 1 / 12);
    return new Series(this.values.map((value, index) => value * Math.pow(monthlyFactor, index)));
  }

  annualize(): number[] {
    const years = Math.ceil(this.length / 12);
    const totals = new Array<number>(years);

    for (let year = 0; year < years; year += 1) {
      const start = year * 12;
      const end = Math.min(this.length, start + 12);
      totals[year] = this.sumRange(start, end);
    }

    return totals;
  }

  forward12(month: number): number {
    Series.assertIndex(month, "month");
    if (month < 0 || month > this.length) {
      throw new RangeError(`month must be between 0 and ${this.length}`);
    }
    const end = Math.min(this.length, month + 12);
    return this.sumRange(month, end);
  }

  trailing12(month: number): number {
    Series.assertIndex(month, "month");
    if (month < 0 || month >= this.length) {
      throw new RangeError(`month must be between 0 and ${Math.max(0, this.length - 1)}`);
    }
    const start = Math.max(0, month - 11);
    return this.sumRange(start, month + 1);
  }

  npv(annualDiscountRate: number): number {
    Series.assertFiniteNumber(annualDiscountRate, "annualDiscountRate");
    if (annualDiscountRate <= -1) {
      throw new RangeError("annualDiscountRate must be greater than -1");
    }

    const monthlyFactor = Math.pow(1 + annualDiscountRate, 1 / 12);
    let total = 0;
    for (let month = 0; month < this.length; month += 1) {
      const value = this.values[month] ?? 0;
      total += value / Math.pow(monthlyFactor, month);
    }
    return total;
  }

  toArray(): number[] {
    return Array.from(this.values);
  }

  map(fn: (value: number, index: number) => number): Series {
    return new Series(
      this.values.map((value, index) => {
        const mapped = fn(value, index);
        if (typeof mapped !== "number" || !Number.isFinite(mapped)) {
          throw new TypeError(`map() callback must return a finite number (index ${index})`);
        }
        return mapped;
      }),
    );
  }

  private elementwise(other: Series | number, fn: (left: number, right: number) => number): Series {
    if (typeof other === "number") {
      Series.assertFiniteNumber(other, "other");
      return new Series(this.values.map((value) => fn(value, other)));
    }

    if (other.length !== this.length) {
      throw new Error(`Series length mismatch: ${this.length} vs ${other.length}`);
    }

    return new Series(this.values.map((value, index) => fn(value, other.get(index))));
  }

  private static assertIndex(value: number, name: string): void {
    if (!Number.isInteger(value)) {
      throw new TypeError(`${name} must be an integer`);
    }
  }

  private static assertLength(length: number): void {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError("length must be a non-negative integer");
    }
  }

  private static assertFiniteNumber(value: number, name: string): void {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number`);
    }
  }

  private static fromLength(length: number, initialValue: number): number[] {
    Series.assertLength(length);
    Series.assertFiniteNumber(initialValue, "initialValue");
    return Array.from({ length }, () => initialValue);
  }
}
