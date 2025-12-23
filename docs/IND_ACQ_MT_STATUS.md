# IND_ACQ_MT Template Status

**Status: QUARANTINED**
**Last Updated:** 2025-12-23
**Reason:** Template formula errors producing nonsensical outputs

## Current Behavior

### Template Routing
- If `template_id: "IND_ACQ_MT"` is explicitly requested, the job fails immediately with error:
  ```
  IND_ACQ_MT is temporarily disabled pending template repair. Use IND_ACQ (single-tenant) instead.
  ```

- If tenant count >= 2 and no explicit template_id is set:
  - Falls back to `IND_ACQ` (single-tenant template)
  - Returns a warning: `"Multi-tenant template is under repair; this run used the single-tenant template."`
  - Job completes successfully using single-tenant template

### Test Cases
- Multi-tenant test cases (`case_003`, `case_004`) are skipped in regression tests
- Output shows: `SKIP: case_003.multi_tenant: IND_ACQ_MT quarantined (template broken)`

## Observed Issues in IND_ACQ_MT Template

| Output | Expected | Actual |
|--------|----------|--------|
| NOI Year 1 | Positive ~$500K | Negative $40M |
| OpEx Year 1 | ~$100K | Negative $598M |
| Exit Proceeds | ~$10M | Negative $10B |
| Unlevered IRR | ~12% | Empty/undefined |
| Levered IRR | ~15% | Empty/undefined |

## Root Cause (Suspected)

The multi-tenant template (`IND_ACQ_MT_v1.0.0_goldmaster.xlsx`) has formula errors in:
- Operating expense calculations
- NOI derivation
- Exit valuation
- IRR/XIRR calculations

These are **template formula issues**, not Excel Engine code issues.

## How to Re-enable

### 1. Repair the Template
- Open `templates/IND_ACQ_MT_v1.0.0_goldmaster.xlsx`
- Debug formulas in Assumptions, Monthly CF, and Investment Summary sheets
- Verify outputs match expected ranges for test case inputs

### 2. Verify with Test Cases
Run the multi-tenant test cases manually:
```bash
# Force-run MT test cases (bypasses quarantine)
cd gpc-app
cat testcases/ind_acq/case_003.multi_tenant.inputs.json | \
  curl -X POST http://localhost:5001/v1/ind-acq/build \
    -H "Content-Type: application/json" \
    -d @-
```

Expected outputs:
- `out.checks.status`: "OK"
- `out.returns.unlevered.irr`: 0.08 - 0.25
- `out.returns.levered.irr`: 0.10 - 0.35
- All values positive and within reasonable ranges

### 3. Remove from Quarantine
1. In `services/excel-engine/Program.cs`:
   - Remove `"IND_ACQ_MT"` from `quarantinedTemplates` HashSet

2. In `scripts/regression-test.sh`:
   - Remove `"IND_ACQ_MT"` from `QUARANTINED_TEMPLATES`

3. Re-run all gates:
   ```bash
   ./scripts/regression-test.sh
   ./scripts/nl-gate-test.sh
   ```

### 4. Deploy
Push changes and verify staging gates pass.

## Files Modified for Quarantine

| File | Change |
|------|--------|
| `services/excel-engine/Program.cs` | Added `quarantinedTemplates` HashSet, fail-fast for explicit MT requests, fallback routing with warning |
| `services/mcp-server/src/index.ts` | Pass through `warning` field in job status response |
| `scripts/regression-test.sh` | Skip quarantined test cases, show skip message |
| `web/widget/src/components/ResultsView.tsx` | Display warning notice |
| `web/widget/src/lib/types.ts` | Added `warning` field to types |
| `web/widget/src/app/globals.css` | Added `.warning-notice` style |

## Timeline

| Date | Event |
|------|-------|
| 2025-12-23 | MT template quarantined after discovering formula errors |
| TBD | Template repair completed |
| TBD | Quarantine lifted, MT cases re-enabled |
