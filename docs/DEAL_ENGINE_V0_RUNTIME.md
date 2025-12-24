# Deal Engine V0 Runtime

## Overview

Code-first CRE underwriting engine that executes deal_engine_v0 schema payloads.

## Execution Order

1. LeaseModule - compute gross potential rent
2. OperatingModule - vacancy, expenses, NOI
3. CapexModule - one-time capital expenditures
4. DevelopmentModule - construction timeline (v0: minimal)
5. DebtModule - loan sizing and amortization
6. EquityModule - cash flow allocation (v0: pro-rata)
7. ExitModule - sale proceeds, IRR, multiple
8. ScenarioModule - sensitivity grids (v0: not implemented)

## V0 Implementation Status

| Module | Status | Notes |
|--------|--------|-------|
| LeaseModule | Implemented | commercial_rent_roll, multifamily_unit_mix, storage_unit_mix, mhp_lot_rent |
| OperatingModule | Implemented | Full expense + inflation logic |
| CapexModule | Implemented | One-time items only |
| DevelopmentModule | Placeholder | Timeline logged, no cash flow impact |
| DebtModule | Implemented | LTV/DSCR sizing, amortization, refinance events |
| EquityModule | Partial | Pro-rata only, waterfall tiers not implemented |
| ExitModule | Implemented | Cap rate reversion, IRR, multiple |
| PortfolioModule | Not implemented | Single-asset only |
| FundModule | Not implemented | |
| ScenarioModule | Not implemented | |

## Running the Engine

```bash
# Build
pnpm --filter @gpc/deal-engine build

# Run on fixture
node scripts/run-deal-engine.mjs testcases/deal_engine_v0/fixtures/ios_acq_stabilized_yard_v1.min.json

# Run tests
pnpm test:deal-engine
```

Adding New Fixtures

1. Create fixture in testcases/deal_engine_v0/fixtures/
2. Validate: pnpm validate:deal-engine-fixtures
3. Run engine and capture output
4. Create expected file in testcases/deal_engine_v0/expected/
5. Add test case to regression.test.ts
