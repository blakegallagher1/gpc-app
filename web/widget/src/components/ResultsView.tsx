"use client";

import type { RunState } from "@/lib/types";

interface Props {
  runState: RunState;
  onRunAgain: () => void;
}

const UI_DEFAULT_METRICS = [
  "out.checks.status",
  "out.checks.error_count",
  "out.returns.unlevered.irr",
  "out.returns.unlevered.multiple",
  "out.returns.levered.irr",
  "out.returns.levered.multiple",
  "out.returns.investor.irr",
  "out.returns.investor.multiple",
  "out.operations.noi_year1",
  "out.debt.acq.loan_amount_sized",
  "out.exit.net_sale_proceeds",
];

const METRIC_LABELS: Record<string, string> = {
  "out.checks.status": "Check Status",
  "out.checks.error_count": "Error Count",
  "out.returns.unlevered.irr": "Unlevered IRR",
  "out.returns.unlevered.multiple": "Unlevered Multiple",
  "out.returns.levered.irr": "Levered IRR",
  "out.returns.levered.multiple": "Levered Multiple",
  "out.returns.investor.irr": "Investor IRR",
  "out.returns.investor.multiple": "Investor Multiple",
  "out.operations.noi_year1": "Year 1 NOI",
  "out.debt.acq.loan_amount_sized": "Loan Amount",
  "out.exit.net_sale_proceeds": "Net Sale Proceeds",
};

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  if (key.includes("irr")) {
    const num = typeof value === "number" ? value : parseFloat(String(value));
    if (isNaN(num)) return String(value);
    return `${(num * 100).toFixed(2)}%`;
  }

  if (key.includes("multiple")) {
    const num = typeof value === "number" ? value : parseFloat(String(value));
    if (isNaN(num)) return String(value);
    return `${num.toFixed(2)}x`;
  }

  if (
    key.includes("noi") ||
    key.includes("loan_amount") ||
    key.includes("proceeds")
  ) {
    const num = typeof value === "number" ? value : parseFloat(String(value));
    if (isNaN(num)) return String(value);
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(num);
  }

  return String(value);
}

export function ResultsView({ runState, onRunAgain }: Props) {
  if (runState.phase === "idle") {
    return null;
  }

  return (
    <div className="results-view">
      <h2>Underwriting Results</h2>

      {/* Status Display */}
      <div className={`status-banner status-${runState.phase}`}>
        {runState.phase === "validating" && "Validating inputs..."}
        {runState.phase === "building" && "Starting build..."}
        {runState.phase === "polling" && (
          <>
            Processing job: <code>{runState.job_id}</code>
          </>
        )}
        {runState.phase === "complete" && "Analysis Complete"}
        {runState.phase === "failed" && (
          <>
            <strong>Failed:</strong> {runState.error}
          </>
        )}
      </div>

      {/* Results */}
      {runState.phase === "complete" && (
        <>
          {/* Check Summary */}
          <div className="check-summary">
            <div
              className={`check-status ${
                runState.outputs["out.checks.status"] === "OK"
                  ? "status-ok"
                  : "status-error"
              }`}
            >
              Status: {String(runState.outputs["out.checks.status"] || "—")}
            </div>
            <div className="check-errors">
              Errors: {String(runState.outputs["out.checks.error_count"] || 0)}
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="metrics-grid">
            {UI_DEFAULT_METRICS.filter(
              (key) => !key.includes("checks")
            ).map((key) => (
              <div key={key} className="metric-card">
                <div className="metric-label">{METRIC_LABELS[key] || key}</div>
                <div className="metric-value">
                  {formatValue(key, runState.outputs[key])}
                </div>
              </div>
            ))}
          </div>

          {/* Download Button */}
          {(runState.download_url || runState.file_path) && (
            <div className="download-section">
              <a
                href={runState.download_url ?? `http://localhost:5001/v1/download?path=${encodeURIComponent(runState.file_path ?? "")}`}
                className="btn btn-download"
                download="IND_ACQ.xlsx"
                target="_blank"
                rel="noopener noreferrer"
              >
                Download Excel
              </a>
              {runState.download_url_expiry && (
                <div className="download-expiry">
                  <small>Link expires: {new Date(runState.download_url_expiry).toLocaleString()}</small>
                </div>
              )}
            </div>
          )}

          {/* Run Again */}
          <div className="action-buttons">
            <button type="button" className="btn btn-secondary" onClick={onRunAgain}>
              Run Again
            </button>
          </div>
        </>
      )}

      {runState.phase === "failed" && (
        <div className="action-buttons">
          <button type="button" className="btn btn-secondary" onClick={onRunAgain}>
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
