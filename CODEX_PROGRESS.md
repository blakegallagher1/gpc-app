# Codex Progress Tracker

This file tracks all pending work items for the GPC App platform. Codex should update this file as work progresses.

**Last Updated:** 2024-12-23
**Status Legend:** `[ ]` Pending | `[~]` In Progress | `[x]` Complete | `[!]` Blocked

---

## A. Immediate Blockers (ChatGPT Usability)

These items block "usable in ChatGPT without friction."

### A1. Template Usability Warning Fix
- [x] Remove `openai/outputTemplate` from hidden `ind_acq.validate_inputs` tool
- [x] Ensure template is associated with public tools only (`ind_acq.build_model`, `ind_acq.get_run_status`)
- [!] Verify in ChatGPT that template warning no longer appears

**Files:**
- `services/mcp-server/src/index.ts`

**Context:** ChatGPT shows a warning when outputTemplate references a hidden tool. validate_inputs is marked `"openai/visibility": "private"` but still has outputTemplate.

---

### A2. Widget Hardening Completion
- [ ] Remove iframe usage - serve widget as direct Skybridge bundle
- [ ] Verify CSP declared in resource `_meta["openai/widgetCSP"]`
- [ ] Verify widget runs fully via `window.openai` APIs:
  - [ ] `callTool()` for MCP tool invocation
  - [ ] `setWidgetState()` for state persistence
  - [ ] `openExternal()` for download links
- [ ] Test widget in ChatGPT sandbox

**Files:**
- `web/skybridge/` (widget source)
- `services/mcp-server/src/index.ts` (CSP config)

**Status Notes:**
```
Server-side CSP: Likely complete (widgetCSP in _meta)
Widget-side openai APIs: May need verification
```

---

## B. Core Underwriting Capabilities

These enable "structure the deal however I want."

### B1. Delayed Closing / Option Period
- [ ] Add `close_month` to schema (default: 0)
- [ ] Add `option_fee` and `reserves_at_option` fields
- [ ] Update Timeline to handle close_month != 0
- [ ] Adjust cashflow alignment (costs at close, not month 0)
- [ ] Update returns calculations for delayed funding

**Schema Changes:**
```json
{
  "acquisition": {
    "close_month": 0,
    "option_fee": 0,
    "reserves_at_closing": 0
  }
}
```

---

### B2. Explicit Rent Step Schedules
- [ ] Add `rent_steps` array to tenant schema
- [ ] Add `economics_mode` toggle: `"bump"` | `"steps"`
- [ ] When mode=steps, ignore `annual_bump_pct`
- [ ] LeaseModule: implement step schedule logic

**Schema Changes:**
```json
{
  "tenant": {
    "economics_mode": "bump",
    "rent_steps": [
      { "start_date": "2026-01-01", "end_date": "2030-12-31", "rent_psf": 12.50 },
      { "start_date": "2031-01-01", "end_date": "2035-12-31", "rent_psf": 14.00 }
    ]
  }
}
```

---

### B3. True NNN Recoveries with Disclosure
- [ ] Model tenant reimbursements explicitly (tax/ins/CAM)
- [ ] Separate recoverable vs non-recoverable expenses
- [ ] Add recoveries inflation rate
- [ ] Add caps/stops per expense category
- [ ] Update OperatingModule for explicit recovery calculations

**Schema Changes:**
```json
{
  "operating": {
    "recoveries": {
      "mode": "NNN",
      "tax_recoverable": true,
      "insurance_recoverable": true,
      "cam_recoverable": true,
      "admin_fee_pct": 0.15,
      "caps": {
        "cam_annual_increase_cap": 0.05
      }
    }
  }
}
```

---

### B4. Landlord Reserve Schedule by Year
- [ ] Add `reserves_schedule` to operating inputs
- [ ] Support year-by-year reserve amounts
- [ ] Integrate into cashflow calculations

**Schema Changes:**
```json
{
  "operating": {
    "reserves_schedule": [
      { "year": 2026, "amount": 10000 },
      { "year": 2027, "amount": 5000 },
      { "year": 2028, "amount": 0 }
    ]
  }
}
```

---

### B5. Advanced Debt Sizing Modes
- [ ] DSCR-only sizing (LTV non-binding)
- [ ] Explicit loan amount mode (user specifies exact amount)
- [ ] Delayed funding support (loan funds at close_month)
- [ ] Covenant testing (DSCR tests by period)
- [ ] Cash sweep mechanics

**Schema Changes:**
```json
{
  "debt": {
    "sizing_mode": "ltv" | "dscr" | "explicit",
    "explicit_loan_amount": null,
    "funding_month": 0,
    "covenants": {
      "min_dscr": 1.25,
      "cash_sweep_trigger_dscr": 1.10
    }
  }
}
```

---

### B6. Equity Waterfall Beyond Pro-Rata
- [ ] Schema scaffold for promotes/catch-ups
- [ ] Multiple LP classes
- [ ] Preferred return tiers
- [ ] GP promote above hurdles
- [ ] Catch-up provisions

**Current Status:** WaterfallModule exists with pro-rata 90/10 only.

**Schema Changes:**
```json
{
  "waterfall": {
    "enabled": true,
    "structure": "tiered",
    "lp_classes": [...],
    "tiers": [
      { "hurdle_irr": 0.08, "lp_split": 1.0, "gp_split": 0.0 },
      { "hurdle_irr": 0.12, "lp_split": 0.80, "gp_split": 0.20 },
      { "hurdle_irr": 0.15, "lp_split": 0.70, "gp_split": 0.30 }
    ]
  }
}
```

---

### B7. Full Sensitivity Grid Runner
- [ ] Exit month grid (48-72 months)
- [ ] Exit cap grid (7.0%-9.0%)
- [ ] Interest rate grid (5.5%-7.0%)
- [ ] Matrix output format for all combinations
- [ ] Integration with MCP response

**Current Status:** ScenarioRunner exists with exit cap/month grid. Rate grid not implemented.

---

## C. Multi-Tenant Support (Currently Quarantined)

### C1. IND_ACQ_MT Template Repair
- [ ] Fix broken template formulas (NOI showing -$40M)
- [ ] Validate multi-tenant NOI aggregation
- [ ] Per-tenant rollover/downtime economics
- [ ] Remove quarantine once fixed

**Current Behavior:** tenant_count >= 2 falls back to IND_ACQ with warning.

**Files:**
- `templates/IND_ACQ_MT.xlsx`
- `contracts/ind_acq_v1.output.mapping.json`

---

### C2. Market Rollover Economics
- [ ] Validate market_rollover table mapping
- [ ] UI support for rollover inputs
- [ ] Downtime months per tenant
- [ ] Free rent at rollover
- [ ] TI/LC at rollover

---

## D. PDF Pack Expansion

### D1. Full 22-Page Investor Pack
- [ ] Waterfall page
- [ ] Comps page
- [ ] Rate curve page
- [ ] Rent Roll Detail page
- [ ] Construction Budget page (if applicable)
- [ ] Tax Analysis page
- [ ] Returns Summary page

**Current:** Pack V1 locked to 11 pages.

---

### D2. Pixel-Diff Coverage Expansion
- [ ] Currently comparing 2 pages (Investment Summary + Assumptions)
- [ ] Add Rent Roll comparison
- [ ] Add Returns Summary comparison
- [ ] Add Operating Budget comparison

---

## E. Reliability / Scale Features

### E1. Job Persistence
- [ ] Excel engine job store is in-memory
- [ ] Add Redis or SQLite persistence
- [ ] Jobs survive server restart

---

### E2. Auth / User Accounts
- [ ] OAuth integration
- [ ] User deal storage
- [ ] Private file storage per user

**Priority:** Not needed for prototype, required for production.

---

### E3. Rate Limiting / Abuse Protection
- [ ] Request rate limiting
- [ ] Per-user quotas
- [ ] Abuse detection

---

## F. Code-First Deal Engine

### F1. Module Contract & Registry
- [x] DealEngine V0 schema (`contracts/deal_engine_v0.schema.json`)
- [x] Module metadata registry (`contracts/module_metadata_v0.json`)

### F2. Executable Modules
- [x] LeaseModule
- [x] OperatingModule
- [x] DebtModule
- [x] ExitModule
- [x] WaterfallModule (pro-rata only)
- [x] ScenarioRunner (exit cap/month grid)

### F3. Infrastructure
- [x] DealEngine orchestrator
- [x] Series/Timeline primitives
- [x] Template library routing layer
- [x] Validation layer (DEAL_ENGINE_VALIDATE flag)

### F4. Testing & Validation
- [ ] Unit tests for all modules
- [ ] Integration tests with sample deals
- [ ] Demo harness for the engine
- [ ] Comparison report: Deal Engine vs Excel Engine

---

## G. Nice-to-Have Improvements

### G1. Schema-Driven Form Generation
- [ ] Widget fields auto-generated from contract schema
- [ ] Validation rules from JSON Schema

### G2. Unified Formatting Library
- [ ] Currency formatting by locale
- [ ] Percentage formatting
- [ ] Multiple formatting
- [ ] Contract currency support

### G3. Assumptions Report
- [ ] Defaults vs user-provided values
- [ ] Risk flags for unusual inputs
- [ ] Audit trail

### G4. Ledger / Transaction View
- [ ] DuckDB or SQLite storage
- [ ] Line-item transaction log
- [ ] Pivot-style reporting

### G5. Document Ingestion
- [ ] Rent roll extraction (PDF/Excel)
- [ ] T12 extraction
- [ ] Lease document parsing
- [ ] Auto-populate inputs from documents

---

## Priority Recommendations

**Top 3 for "Real Deal Structuring":**
1. B1: Delayed closing (`close_month`) + pre-close reserves
2. B2: Explicit rent steps table + `economics_mode` toggle
3. B6: Equity waterfall schema scaffold (promotes)

**Top 3 for "Production Ready":**
1. A1: Template usability fix (ChatGPT blocker)
2. C1: Multi-tenant template repair
3. E1: Job persistence

---

## Session Log

Use this section to log progress during work sessions.

```
2024-12-23: File created with full inventory of pending work
- Phases 1-7 of Deal Engine complete
- WaterfallModule and ScenarioRunner implemented (V0 scope)
- Pending: Advanced features listed above
2025-12-23 01:52 - [A1] Verified outputTemplate scope for IND_ACQ tools
- Confirmed validate_inputs is private without outputTemplate; public tools retain template
- File: services/mcp-server/src/index.ts
- Note: ChatGPT UI verification still pending (needs manual sandbox check)
```

---

## Quick Reference

**Key Directories:**
- `services/deal-engine/` - Code-first engine
- `services/mcp-server/` - MCP server for ChatGPT
- `services/template-library/` - Template routing
- `contracts/` - JSON schemas and mappings
- `templates/` - Excel templates
- `web/skybridge/` - Widget source

**Key Commands:**
```bash
# Build all
pnpm build

# Test deal engine
pnpm --filter @gpc/deal-engine test

# Build MCP server
pnpm --filter @gpc/mcp-server build

# Run MCP server locally
pnpm --filter @gpc/mcp-server start
```
