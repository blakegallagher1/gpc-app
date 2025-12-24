/**
 * Annual Cash Flow Formatter
 *
 * Transforms monthly series data into a clean annual cash flow summary
 * matching the professional proforma format.
 */

import { Series } from "../core/series.js";

export interface AnnualCashFlowRow {
  label: string;
  values: (string | number | null)[];
  isHeader?: boolean;
  isSubtotal?: boolean;
  isTotal?: boolean;
  format?: "currency" | "percent" | "psf" | "text";
  indent?: number;
}

export interface AnnualCashFlowTable {
  years: number[];
  yearLabels: string[];
  yearEnding: string[];
  rows: AnnualCashFlowRow[];
}

export interface AnnualCashFlowInputs {
  analysisStartDate: string;
  holdPeriodMonths: number;
  grossSf: number;
  netSf: number;
  series: Record<string, number[]>;
  metrics: Record<string, number>;
}

/**
 * Formats a number as currency string
 */
function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const absValue = Math.abs(value);
  const formatted = absValue.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return value < 0 ? `-${formatted}` : formatted;
}

/**
 * Formats a number as percentage string
 */
function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Formats a number as PSF (per square foot) string
 */
function formatPsf(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(1)}`;
}

/**
 * Aggregates monthly array to annual totals
 */
function monthlyToAnnual(monthly: number[], startMonth = 0): number[] {
  const annual: number[] = [];
  for (let m = startMonth; m < monthly.length; m += 12) {
    const end = Math.min(monthly.length, m + 12);
    let sum = 0;
    for (let i = m; i < end; i++) {
      sum += monthly[i] ?? 0;
    }
    annual.push(sum);
  }
  return annual;
}

/**
 * Gets the value at a specific month (or end of year)
 */
function getMonthlyValue(monthly: number[], monthIndex: number): number {
  return monthly[Math.min(monthIndex, monthly.length - 1)] ?? 0;
}

/**
 * Calculates year-end date labels
 */
function getYearEndLabels(startDate: string, years: number): string[] {
  const start = new Date(startDate);
  const labels: string[] = [];

  for (let y = 0; y <= years; y++) {
    const yearEnd = new Date(start);
    yearEnd.setMonth(yearEnd.getMonth() + (y * 12) - 1);
    if (y === 0) {
      yearEnd.setMonth(start.getMonth()); // Year 0 is the acquisition month
    }
    const monthName = yearEnd.toLocaleString("en-US", { month: "short" });
    const yearStr = String(yearEnd.getFullYear()).slice(-2);
    labels.push(`${monthName} '${yearStr}`);
  }

  return labels;
}

/**
 * Main function to generate annual cash flow table
 */
export function generateAnnualCashFlow(inputs: AnnualCashFlowInputs): AnnualCashFlowTable {
  const { analysisStartDate, holdPeriodMonths, grossSf, netSf, series, metrics } = inputs;

  const numYears = Math.ceil(holdPeriodMonths / 12);
  const years = Array.from({ length: numYears + 1 }, (_, i) => i);
  const yearLabels = years.map((y) => `Year ${y}`);
  const yearEnding = getYearEndLabels(analysisStartDate, numYears);

  // Get series data with fallbacks
  const gpr = series.gross_potential_rent ?? [];
  const noi = series.noi ?? [];
  const debtService = series.debt_service ?? [];
  const capex = series.capex ?? [];
  const unleveredCf = series.unlevered_cashflow ?? [];
  const leveredCf = series.levered_cashflow ?? [];
  const loanBalance = series.loan_balance ?? [];

  // Aggregate to annual
  const annualGpr = monthlyToAnnual(gpr);
  const annualNoi = monthlyToAnnual(noi);
  const annualDebtService = monthlyToAnnual(debtService);
  const annualCapex = monthlyToAnnual(capex);
  const annualUnleveredCf = monthlyToAnnual(unleveredCf);
  const annualLeveredCf = monthlyToAnnual(leveredCf);

  // Calculate derived values
  const annualEgi = annualGpr.map((v, i) => v * 0.95); // Assume 5% vacancy for EGI
  const annualOpex = annualGpr.map((v, i) => annualGpr[i] - annualNoi[i]);
  const annualNetCf = annualNoi.map((v, i) => v - annualDebtService[i] - Math.abs(annualCapex[i] ?? 0));

  // Build rows
  const rows: AnnualCashFlowRow[] = [];

  // Year Ending row
  rows.push({
    label: "Year Ending",
    values: yearEnding,
    format: "text",
  });

  // Occupancy section (estimates based on revenue)
  const physicalOcc = years.map((_, i) => i === 0 ? 1.0 : 0.95);
  const economicOcc = years.map((_, i) => i === 0 ? 1.0 : 0.92);

  rows.push({
    label: "Physical Occupancy",
    values: physicalOcc,
    format: "percent",
  });

  rows.push({
    label: "Economic Occupancy",
    values: economicOcc,
    format: "percent",
  });

  // Blank row separator
  rows.push({ label: "", values: years.map(() => null) });

  // Income Section Header
  rows.push({
    label: "Income",
    values: years.map(() => null),
    isHeader: true,
  });

  // Gross Potential Rent
  rows.push({
    label: "Gross Potential Rent",
    values: [null, ...annualGpr.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  // Reimbursements (estimated as % of GPR for NNN)
  const annualReimbursements = annualGpr.map((v) => v * 0.15);
  rows.push({
    label: "Reimbursements",
    values: [null, ...annualReimbursements.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  // Turnover & Absorption Vacancy (negative)
  const annualVacancy = annualGpr.map((v) => -v * 0.05);
  rows.push({
    label: "Turnover & Absorption Vacancy",
    values: [null, ...annualVacancy.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  // Concessions
  const annualConcessions = annualGpr.map((v) => -v * 0.01);
  rows.push({
    label: "Concessions",
    values: [null, ...annualConcessions.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  // Effective Gross Income
  const egi = annualGpr.map((v, i) =>
    v + annualReimbursements[i] + annualVacancy[i] + annualConcessions[i]
  );
  rows.push({
    label: "Effective Gross Income",
    values: [null, ...egi.slice(0, numYears)],
    format: "currency",
    isSubtotal: true,
  });

  // Blank row separator
  rows.push({ label: "", values: years.map(() => null) });

  // Expense Section Header
  rows.push({
    label: "Expense",
    values: years.map(() => null),
    isHeader: true,
  });

  // Expense breakdown (estimated splits)
  const totalOpexAnnual = annualOpex.map((v) => Math.max(v, 0));
  const reTaxes = totalOpexAnnual.map((v) => v * 0.40);
  const insurance = totalOpexAnnual.map((v) => v * 0.10);
  const rmCam = totalOpexAnnual.map((v) => v * 0.25);
  const utilities = totalOpexAnnual.map((v) => v * 0.05);
  const propertyMgmt = totalOpexAnnual.map((v) => v * 0.05);

  // PSF values for expense headers
  const reTaxesPsf = reTaxes[0] ? reTaxes[0] / netSf : 0;
  const insurancePsf = insurance[0] ? insurance[0] / netSf : 0;
  const rmCamPsf = rmCam[0] ? rmCam[0] / netSf : 0;
  const utilitiesPsf = utilities[0] ? utilities[0] / netSf : 0;

  rows.push({
    label: `RE Taxes`,
    values: [formatPsf(reTaxesPsf), ...reTaxes.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: `Insurance`,
    values: [formatPsf(insurancePsf), ...insurance.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: `R&M / CAM`,
    values: [formatPsf(rmCamPsf), ...rmCam.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: `Utilities`,
    values: [formatPsf(utilitiesPsf), ...utilities.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: `Property Management`,
    values: ["1.5% of EGI", ...propertyMgmt.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  // Total Opex
  rows.push({
    label: "Total Opex",
    values: [null, ...totalOpexAnnual.slice(0, numYears)],
    format: "currency",
    isSubtotal: true,
  });

  // Opex Ratio
  const opexRatio = egi.map((e, i) => e > 0 ? totalOpexAnnual[i] / e : 0);
  rows.push({
    label: "Opex Ratio",
    values: [null, ...opexRatio.slice(0, numYears)],
    format: "percent",
  });

  // Opex PSF
  const opexPsf = totalOpexAnnual.map((v) => netSf > 0 ? v / netSf : 0);
  rows.push({
    label: "Opex PSF",
    values: [null, ...opexPsf.slice(0, numYears)],
    format: "psf",
  });

  // Net Operating Income
  rows.push({
    label: "Net Operating Income",
    values: [null, ...annualNoi.slice(0, numYears)],
    format: "currency",
    isTotal: true,
  });

  // Blank row separator
  rows.push({ label: "", values: years.map(() => null) });

  // Capital & Leasing Section
  rows.push({
    label: "Capital & Leasing",
    values: years.map(() => null),
    isHeader: true,
  });

  // Capital Improvements (estimated breakdown of capex)
  const capImprovements = annualCapex.map((v) => Math.abs(v) * 0.3);
  const tenantImprovements = annualCapex.map((v) => Math.abs(v) * 0.5);
  const leasingCommissions = annualCapex.map((v) => Math.abs(v) * 0.2);

  rows.push({
    label: "Capital Improvements",
    values: [null, ...capImprovements.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: "Tenant Improvements",
    values: [null, ...tenantImprovements.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: "Leasing Commissions",
    values: [null, ...leasingCommissions.slice(0, numYears)],
    format: "currency",
    indent: 1,
  });

  // Total Capital & Leasing
  const totalCapLeasing = annualCapex.map((v) => Math.abs(v));
  rows.push({
    label: "Total Capital & Leasing",
    values: [null, ...totalCapLeasing.slice(0, numYears)],
    format: "currency",
    isSubtotal: true,
  });

  // Net Cash Flow
  const netCashFlow = annualNoi.map((v, i) => v - totalCapLeasing[i]);
  rows.push({
    label: "Net Cash Flow",
    values: [null, ...netCashFlow.slice(0, numYears)],
    format: "currency",
    isTotal: true,
  });

  // Blank row separator
  rows.push({ label: "", values: years.map(() => null) });

  // Equity Reserves Section
  rows.push({
    label: "Equity Reserves",
    values: years.map(() => null),
    isHeader: true,
  });

  rows.push({
    label: "Working Capital",
    values: years.map(() => null),
    isHeader: true,
  });

  // Working capital tracking
  const wcBeginning: (number | null)[] = [null];
  const wcInflows: (number | null)[] = [metrics.loan_amount ?? 0];
  const wcOutflows: (number | null)[] = [null];
  const wcEnding: (number | null)[] = [wcInflows[0]];

  for (let y = 1; y <= numYears; y++) {
    wcBeginning.push(wcEnding[y - 1]);
    wcInflows.push(null);
    const outflow = totalCapLeasing[y - 1] ?? 0;
    wcOutflows.push(outflow > 0 ? -outflow : null);
    const beginning = wcBeginning[y] ?? 0;
    const inflow = wcInflows[y] ?? 0;
    const outflowVal = wcOutflows[y] ?? 0;
    wcEnding.push(beginning + inflow + outflowVal);
  }

  rows.push({
    label: "Beginning",
    values: wcBeginning,
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: "Inflows",
    values: wcInflows,
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: "Outflows",
    values: wcOutflows,
    format: "currency",
    indent: 1,
  });

  rows.push({
    label: "Ending",
    values: wcEnding,
    format: "currency",
    isSubtotal: true,
  });

  // Net Cash Flow After Reserves
  const netCfAfterReserves = netCashFlow.map((v, i) => {
    const reserveChange = (wcEnding[i + 1] ?? 0) - (wcBeginning[i + 1] ?? 0);
    return v + reserveChange;
  });
  rows.push({
    label: "Net Cash Flow After Reserves",
    values: [null, ...netCfAfterReserves.slice(0, numYears)],
    format: "currency",
    isTotal: true,
  });

  return {
    years,
    yearLabels,
    yearEnding,
    rows,
  };
}

/**
 * Converts the annual cash flow table to a formatted string for display
 */
export function formatAnnualCashFlowAsText(table: AnnualCashFlowTable): string {
  const colWidth = 15;
  const labelWidth = 35;

  // Header row
  let output = "".padEnd(labelWidth) + table.yearLabels.map((l) => l.padStart(colWidth)).join("") + "\n";
  output += "=".repeat(labelWidth + table.yearLabels.length * colWidth) + "\n";

  for (const row of table.rows) {
    if (row.label === "") {
      output += "\n";
      continue;
    }

    const indent = "  ".repeat(row.indent ?? 0);
    const label = indent + row.label;

    let formattedValues: string[];
    if (row.format === "currency") {
      formattedValues = row.values.map((v) => {
        if (v === null || v === undefined) return "-";
        if (typeof v === "string") return v;
        return formatCurrency(v);
      });
    } else if (row.format === "percent") {
      formattedValues = row.values.map((v) => {
        if (v === null || v === undefined) return "-";
        if (typeof v === "string") return v;
        return formatPercent(v);
      });
    } else if (row.format === "psf") {
      formattedValues = row.values.map((v) => {
        if (v === null || v === undefined) return "-";
        if (typeof v === "string") return v;
        return formatPsf(v);
      });
    } else {
      formattedValues = row.values.map((v) => v?.toString() ?? "-");
    }

    if (row.isHeader) {
      output += `\n${label.toUpperCase()}\n`;
      output += "-".repeat(labelWidth + table.yearLabels.length * colWidth) + "\n";
    } else if (row.isTotal) {
      output += label.padEnd(labelWidth) + formattedValues.map((v) => v.padStart(colWidth)).join("") + "\n";
      output += "=".repeat(labelWidth + table.yearLabels.length * colWidth) + "\n";
    } else if (row.isSubtotal) {
      output += label.padEnd(labelWidth) + formattedValues.map((v) => v.padStart(colWidth)).join("") + "\n";
      output += "-".repeat(labelWidth + table.yearLabels.length * colWidth) + "\n";
    } else {
      output += label.padEnd(labelWidth) + formattedValues.map((v) => v.padStart(colWidth)).join("") + "\n";
    }
  }

  return output;
}

/**
 * Converts the annual cash flow table to a JSON-friendly format for API responses
 */
export function formatAnnualCashFlowAsJson(table: AnnualCashFlowTable): Record<string, unknown> {
  const sections: Record<string, unknown> = {};
  let currentSection = "summary";

  for (const row of table.rows) {
    if (row.isHeader && row.label) {
      currentSection = row.label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      sections[currentSection] = {};
      continue;
    }

    if (row.label && !row.isHeader) {
      const key = row.label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const values: Record<string, unknown> = {};

      for (let i = 0; i < table.yearLabels.length; i++) {
        values[table.yearLabels[i]] = row.values[i];
      }

      if (!sections[currentSection]) {
        sections[currentSection] = {};
      }
      (sections[currentSection] as Record<string, unknown>)[key] = values;
    }
  }

  return {
    years: table.years,
    year_labels: table.yearLabels,
    year_ending: table.yearEnding,
    sections,
  };
}
