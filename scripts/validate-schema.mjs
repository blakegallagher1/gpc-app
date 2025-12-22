#!/usr/bin/env node
/**
 * CI Schema Validation Script
 * Validates that widget default-inputs.ts matches contracts/ind_acq_v1.input.schema.json
 *
 * Usage: node scripts/validate-schema.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Load the schema
const schemaPath = join(rootDir, 'contracts', 'ind_acq_v1.input.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

// The default inputs from TypeScript (converted to JSON for validation)
// This mirrors web/widget/src/lib/default-inputs.ts
const defaultInputs = {
  contract: {
    contract_version: "IND_ACQ_V1",
    template_id: "IND_ACQ",
    template_version_target: "1.0.0",
    request_id: "widget_run",
    currency: "USD",
  },
  deal: {
    project_name: "Case 001 Industrial",
    city: "Dallas",
    state: "TX",
    analysis_start_date: "2026-01-01",
    hold_period_months: 60,
    gross_sf: 10000,
    net_sf: 10000,
  },
  acquisition: {
    purchase_price: 1000000,
    closing_cost_pct: 0.02,
    acquisition_fee_pct: 0.01,
    legal_costs: 15000,
    other_financing_fees: 5000,
  },
  operating: {
    vacancy_pct: 0.05,
    credit_loss_pct: 0.01,
    inflation: {
      rent: 0.02,
      expenses: 0.02,
      taxes: 0.02,
    },
    expenses: {
      management_fee_pct_egi: 0.03,
      fixed_annual: {
        insurance: 15000,
        utilities: 12000,
        repairs_maintenance: 5000,
        security: 0,
        property_taxes: 8000,
        other_expense_1: 2000,
      },
      recoveries: {
        mode: "NNN",
      },
      capex_reserves_per_nsf_annual: 0.2,
    },
  },
  rent_roll: {
    tenants_in_place: [
      {
        tenant_name: "Single Tenant",
        sf: 10000,
        lease_start: "2026-01-01",
        lease_end: "2035-12-31",
        current_rent_psf_annual: 18,
        annual_bump_pct: 0.02,
        lease_type: "NNN",
        free_rent_months: 0,
        ti: { mode: "PER_SF", value: 5 },
        lc: { mode: "PCT_RENT", value: 0.04 },
        comments: "10-year NNN lease",
      },
    ],
  },
  debt: {
    acquisition_loan: {
      enabled: true,
      ltv_max: 0.6,
      amort_years: 25,
      io_months: 0,
      term_months: 60,
      origination_fee_pct: 0.01,
      rate: {
        type: "FIXED",
        fixed_rate: 0.055,
      },
    },
  },
  exit: {
    exit_month: 60,
    exit_cap_rate: 0.06,
    sale_cost_pct: 0.02,
    forward_noi_months: 12,
  },
};

// Setup AJV validator (using 2020-12 draft)
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validate = ajv.compile(schema);
const valid = validate(defaultInputs);

if (valid) {
  console.log('✓ Default inputs validate against schema');
  process.exit(0);
} else {
  console.error('✗ Schema validation failed:');
  for (const err of validate.errors) {
    console.error(`  - ${err.instancePath || '/'}: ${err.message}`);
  }
  process.exit(1);
}
