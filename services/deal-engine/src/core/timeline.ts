import { DateTime } from "luxon";

export interface TimelineConfig {
  startDate: string; // ISO date string (e.g., '2026-01-01')
  holdPeriodMonths: number; // Total months in analysis
  exitMonth?: number; // Optional, defaults to holdPeriodMonths
  closeMonth?: number; // Optional, defaults to 0
}

export class Timeline {
  readonly startDate: DateTime;
  readonly holdPeriodMonths: number;
  readonly exitMonth: number;
  readonly closeMonth: number;
  readonly endDate: DateTime;

  constructor(config: TimelineConfig) {
    if (!Number.isInteger(config.holdPeriodMonths) || config.holdPeriodMonths <= 0) {
      throw new Error("holdPeriodMonths must be a positive integer");
    }

    const startDate = DateTime.fromISO(config.startDate, { zone: "utc" }).startOf("month");
    if (!startDate.isValid) {
      throw new Error(`Invalid startDate: ${config.startDate}`);
    }

    const exitMonth = config.exitMonth ?? config.holdPeriodMonths;
    if (!Number.isInteger(exitMonth) || exitMonth <= 0 || exitMonth > config.holdPeriodMonths) {
      throw new Error("exitMonth must be an integer between 1 and holdPeriodMonths");
    }

    const closeMonth = config.closeMonth ?? 0;
    if (!Number.isInteger(closeMonth) || closeMonth < 0 || closeMonth >= exitMonth) {
      throw new Error("closeMonth must be an integer between 0 and exitMonth - 1");
    }

    this.startDate = startDate;
    this.holdPeriodMonths = config.holdPeriodMonths;
    this.exitMonth = exitMonth;
    this.closeMonth = closeMonth;
    this.endDate = this.startDate.plus({ months: this.holdPeriodMonths });
  }

  monthIndex(date: DateTime | string): number {
    const dt = this.coerceDateTime(date);
    return (dt.year - this.startDate.year) * 12 + (dt.month - this.startDate.month);
  }

  dateAt(monthIndex: number): DateTime {
    if (!Number.isInteger(monthIndex)) {
      throw new Error("monthIndex must be an integer");
    }
    if (monthIndex < 0 || monthIndex >= this.holdPeriodMonths) {
      throw new RangeError(`monthIndex must be between 0 and ${this.holdPeriodMonths - 1}`);
    }
    return this.startDate.plus({ months: monthIndex });
  }

  isInPeriod(date: DateTime | string): boolean {
    const idx = this.monthIndex(date);
    return idx >= 0 && idx < this.holdPeriodMonths;
  }

  get totalMonths(): number {
    return this.holdPeriodMonths;
  }

  *months(): Generator<number> {
    for (let i = 0; i < this.totalMonths; i += 1) {
      yield i;
    }
  }

  private coerceDateTime(date: DateTime | string): DateTime {
    const zone = this.startDate.zoneName ?? "utc";
    const dt = typeof date === "string" ? DateTime.fromISO(date, { zone }) : date;
    if (!dt.isValid) {
      throw new Error("Invalid date");
    }
    return dt;
  }
}
