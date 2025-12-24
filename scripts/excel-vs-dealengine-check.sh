#!/bin/bash
set -euo pipefail

FIXTURE_PATH=${1:-testcases/deal_engine_v0/fixtures/ios_acq_stabilized_yard_v1.min.json}
EXCEL_OUTPUT_PATH=${2:-}

DEAL_OUTPUT_PATH="/tmp/deal-engine-v0-output.json"

echo "Running Deal Engine V0 on ${FIXTURE_PATH}..."
node scripts/run-deal-engine.mjs "$FIXTURE_PATH" > "$DEAL_OUTPUT_PATH"
echo "Deal Engine output saved to ${DEAL_OUTPUT_PATH}"

if [[ -z "$EXCEL_OUTPUT_PATH" ]]; then
  echo "Excel output path not provided."
  echo "Provide Excel output JSON as the second argument to compare metrics:"
  echo "  scripts/excel-vs-dealengine-check.sh <fixture.json> <excel_output.json>"
  exit 0
fi

if [[ ! -f "$EXCEL_OUTPUT_PATH" ]]; then
  echo "Excel output file not found: ${EXCEL_OUTPUT_PATH}"
  exit 1
fi

node - <<'NODE' "$EXCEL_OUTPUT_PATH" "$DEAL_OUTPUT_PATH"
const fs = require('fs');
const [excelPath, dealPath] = process.argv.slice(1);

const excelRaw = JSON.parse(fs.readFileSync(excelPath, 'utf8'));
const dealRaw = JSON.parse(fs.readFileSync(dealPath, 'utf8'));

const excel = excelRaw.outputs ?? excelRaw;
const deal = dealRaw.metrics ?? dealRaw;

const metrics = [
  { key: 'unlevered_irr', excelKey: 'out.returns.unlevered.irr', type: 'irr' },
  { key: 'levered_irr', excelKey: 'out.returns.levered.irr', type: 'irr' },
  { key: 'noi_year1', excelKey: 'out.cashflow.year_1_noi', type: 'pct' },
  { key: 'loan_amount', excelKey: 'out.debt.total_proceeds', type: 'pct' },
];

const thresholds = { irr: 0.0025, pct: 0.5 };
let failed = false;

for (const metric of metrics) {
  const excelValue = Number(excel[metric.excelKey]);
  const dealValue = Number(deal[metric.key]);
  if (!Number.isFinite(excelValue) || !Number.isFinite(dealValue)) {
    console.log(`${metric.key}: missing in comparison data`);
    continue;
  }

  let delta;
  let within;
  if (metric.type === 'irr') {
    delta = Math.abs(excelValue - dealValue);
    within = delta <= thresholds.irr;
    console.log(`${metric.key}: excel=${excelValue} deal=${dealValue} delta=${delta} (<= ${thresholds.irr}) ${within ? 'OK' : 'OUT'}`);
  } else {
    const pctDiff = Math.abs((excelValue - dealValue) / (excelValue || 1)) * 100;
    within = pctDiff <= thresholds.pct;
    console.log(`${metric.key}: excel=${excelValue} deal=${dealValue} pctDiff=${pctDiff.toFixed(2)}% (<= ${thresholds.pct}%) ${within ? 'OK' : 'OUT'}`);
  }

  if (!within) failed = true;
}

if (failed) {
  console.error('Comparison failed thresholds.');
  process.exit(1);
}
NODE
