import { DateTime } from "luxon";

// Parse ISO date string to DateTime
export function parseDate(date: string): DateTime {
  if (typeof date !== "string") {
    throw new TypeError("date must be a string");
  }

  const parsed = DateTime.fromISO(date, { zone: "utc" });
  if (!parsed.isValid) {
    throw new Error(`Invalid ISO date: ${date}`);
  }

  return parsed;
}

// Get months between two dates
export function monthsBetween(start: DateTime, end: DateTime): number {
  assertValidDateTime(start, "start");
  assertValidDateTime(end, "end");

  const startMonth = start.startOf("month");
  const endMonth = end.startOf("month");
  return (endMonth.year - startMonth.year) * 12 + (endMonth.month - startMonth.month);
}

// Add months to a date
export function addMonths(date: DateTime, months: number): DateTime {
  assertValidDateTime(date, "date");
  assertFiniteNumber(months, "months");
  if (!Number.isInteger(months)) {
    throw new TypeError("months must be an integer");
  }
  return date.plus({ months });
}

// Check if date is start of month
export function isStartOfMonth(date: DateTime): boolean {
  assertValidDateTime(date, "date");
  return date.equals(date.startOf("month"));
}

// Get start of month for a date
export function startOfMonth(date: DateTime): DateTime {
  assertValidDateTime(date, "date");
  return date.startOf("month");
}

function assertValidDateTime(value: DateTime, name: string): void {
  if (!(value instanceof DateTime)) {
    throw new TypeError(`${name} must be a DateTime`);
  }
  if (!value.isValid) {
    throw new Error(`${name} must be a valid DateTime`);
  }
}

function assertFiniteNumber(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

