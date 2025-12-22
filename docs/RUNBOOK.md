# Runbook

## Requirements

- **Node.js**: v20+
- **.NET**: 8.0 LTS (required for Excel Engine)
- **pnpm**: v8+

## Local Dev (3 terminals)

Start all services for local development:

### Terminal 1: Excel Engine (.NET 8)
```bash
cd services/excel-engine

# macOS with Homebrew .NET 8
export DOTNET_ROOT="/opt/homebrew/opt/dotnet@8/libexec"
export PATH="/opt/homebrew/opt/dotnet@8/bin:$PATH"

dotnet run
```
API: `http://localhost:5001`

### Terminal 2: MCP Server
```bash
pnpm install
pnpm --filter @gpc/mcp-server dev
```
MCP: `http://localhost:8000/mcp`

### Terminal 3: Widget UI
```bash
pnpm install
pnpm --filter @gpc/widget dev
```
Widget: `http://localhost:3001`

---

## Smoke Test Checklist

After starting all 3 services, verify the full flow:

- [ ] **Open widget page**: Navigate to http://localhost:3001
- [ ] **Validate inputs**: Click "Validate" button - should show "Inputs validated successfully"
- [ ] **Run Underwrite**: Click "Run Underwrite" button - status should progress through "Validating" → "Building" → "Processing" → "Complete"
- [ ] **Confirm results populate**:
  - Check Status = "OK"
  - Error Count = 0
  - Unlevered IRR shows a percentage
  - Levered IRR shows a percentage
  - Year 1 NOI shows a currency value
  - Loan Amount shows a currency value
- [ ] **Download Excel**: Click "Download Excel" button - should download IND_ACQ.xlsx file
- [ ] **Run Again**: Click "Run Again" - should return to inputs view with values preserved

---

## Regression Tests

Run the full regression test suite (requires both services running):

```bash
# Start services first (see Local Dev section)
./scripts/regression-test.sh
```

Expected output: All tests pass with IRRs in target ranges (Unlevered: 8-18%, Levered: 12-25%).

**Note**: E2E regression tests require running services. CI validates builds and contracts only. Run regression tests locally before merging or in a staging environment.

---

## Staging Gate

Before deploying to production, run both gate tests against staging:

```bash
# Set staging MCP URL
export MCP_URL="https://mcp-server-xxx.onrender.com"
export OPENAI_API_KEY="sk-..."

# Run regression tests
./scripts/regression-test.sh

# Run NL extraction gate tests
./scripts/nl-gate-test.sh
```

### Gate Test Requirements

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| Regression | Core model execution | All cases pass, IRRs in range |
| NL Gate | Extraction + validation | Complete prompts validate, incomplete return missing_fields |

### NL Gate Test Cases

1. **Complete single-tenant** - Returns `status=ok`, inputs validate
2. **Complete multi-tenant** - Returns `status=ok`, 3 tenants extracted, inputs validate
3. **Incomplete prompt** - Returns `status=needs_info`, critical fields listed as missing

### Staging Deployment

1. **Render Dashboard** → Deploy MCP Server and Excel Engine from main
2. **Vercel Dashboard** → Deploy Widget from main
3. **Verify health endpoints**:
   ```bash
   curl https://mcp-server-xxx.onrender.com/health
   curl https://excel-engine-xxx.onrender.com/health
   ```
4. **Run gate tests** against staging URLs
5. **Smoke test** via widget UI

---

## Natural Language Intake

The `build_model` tool supports natural language input for deal extraction. Users can describe a deal in plain English, and the system extracts structured inputs using GPT-5.1.

### How It Works

1. **Extract Mode**: Call `build_model` with `natural_language` and `mode="extract_only"`
2. **Two-Pass Extraction**:
   - Pass 1: Initial extraction with JSON schema
   - Pass 2: Reflection pass to catch any missed details
3. **Validation**: Extracted values are validated and missing critical fields are identified
4. **Response**: Returns extracted `inputs`, `missing_fields`, and `suggested_defaults`

### Example Request

```bash
curl -s -X POST "http://localhost:8000/mcp" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "ind_acq.build_model",
      "arguments": {
        "natural_language": "Build me an acquisition model for a 50,000 SF industrial building in Houston, TX. Purchase price is $5M, 65% LTV, 5.75% interest rate.",
        "mode": "extract_only"
      }
    }
  }'
```

### Response Statuses

| Status | Description |
|--------|-------------|
| `ok` | All critical fields extracted, ready to run |
| `needs_info` | Missing critical fields, user must provide more info |

### Critical Missing Fields

The following fields are considered **critical** for running a model. If any are missing, the response status will be `needs_info`:

| Path | Description |
|------|-------------|
| `acquisition.purchase_price` | Deal purchase price |
| `rent_roll.tenants_in_place` | At least one tenant in the rent roll |
| `exit.exit_cap_rate` | Exit cap rate for disposition |
| `debt.acquisition_loan.ltv_max` | Loan-to-value ratio |
| `debt.acquisition_loan.rate.fixed_rate` | Debt interest rate |

### Default Values

When fields are not specified, these defaults are applied:

| Path | Default |
|------|---------|
| `contract.contract_version` | `IND_ACQ_V1` |
| `operating.vacancy_pct` | `0.05` (5%) |
| `operating.mgmt_pct` | `0.03` (3%) |
| `operating.expense_stop_psf` | `0` |
| `acquisition.closing_costs_pct` | `0.015` (1.5%) |
| `debt.acquisition_loan.amort_years` | `30` |
| `debt.acquisition_loan.io_years` | `0` |
| `exit.disposition_costs_pct` | `0.02` (2%) |

### NL Extraction Tests

Run the NL extraction regression tests:

```bash
# Requires OPENAI_API_KEY and MCP server running
export OPENAI_API_KEY="sk-..."
./scripts/test-nl-extraction.sh
```

Test cases are in `testcases/nl_extraction/`:
- `prompt_001.simple_single_tenant.json` - Basic single-tenant deal
- `prompt_002.multi_tenant.json` - Multi-tenant with staggered leases

---

## MCP Server (services/mcp-server)

```bash
PORT=8000 pnpm --filter @gpc/mcp-server dev
```

MCP endpoint: `http://localhost:8000/mcp`
Health: `http://localhost:8000/health`

### Call MCP tools (local)

```bash
build_payload=$(jq -n \
  --argfile inputs testcases/ind_acq/case_001.inputs.json \
  '{jsonrpc:"2.0", id:"1", method:"tools/call", params:{name:"ind_acq.build_model", arguments:{inputs:$inputs}}}')

job_id=$(curl -s "http://localhost:8000/mcp" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d "$build_payload" | jq -r '.result.structuredContent.job_id')

echo "job_id=$job_id"

while true; do
  poll_payload=$(jq -n \
    --arg job_id "$job_id" \
    '{jsonrpc:"2.0", id:"2", method:"tools/call", params:{name:"ind_acq.get_run_status", arguments:{job_id:$job_id}}}')
  response=$(curl -s "http://localhost:8000/mcp" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -d "$poll_payload")
  status=$(echo "$response" | jq -r '.result.structuredContent.status')
  echo "status=$status"

  if [ "$status" = "complete" ] || [ "$status" = "failed" ]; then
    echo "$response" | jq
    break
  fi

  sleep 1
done
```

## Excel Engine (services/excel-engine)

Requires .NET 8.0 LTS.

```bash
cd services/excel-engine
dotnet restore
dotnet run
```

API base: `http://localhost:5001`
Health: `http://localhost:5001/health`

### Build request (local)

```bash
payload=$(jq -n \
  --argfile inputs testcases/ind_acq/case_001.inputs.json \
  --argfile mapping contracts/ind_acq_v1.output.mapping.json \
  '{inputs: $inputs, mapping: $mapping.mapping}')

job_id=$(curl -s -X POST "http://localhost:5001/v1/ind-acq/build" \
  -H "content-type: application/json" \
  -d "$payload" | jq -r '.job_id')

echo "job_id=$job_id"

while true; do
  response=$(curl -s "http://localhost:5001/v1/jobs/${job_id}")
  status=$(echo "$response" | jq -r '.status')
  echo "status=$status"

  if [ "$status" = "complete" ] || [ "$status" = "failed" ]; then
    echo "$response" | jq
    break
  fi

  sleep 1
done
```

---

## Cloud Deployment

### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Vercel         │     │  Render         │     │  Render         │
│  Widget UI      │◄────│  MCP Server     │────►│  Excel Engine   │
│  (Next.js)      │     │  (Node.js 20)   │     │  (.NET 8 LTS)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  Backblaze B2   │
                                                │  (Native API)   │
                                                └─────────────────┘
```

### Deploy to Render (Blueprint)

1. Push to GitHub
2. Create new Blueprint in Render Dashboard
3. Connect your repository
4. Render will detect `render.yaml` and create services
5. Configure environment variables (see below)

### Deploy Widget to Vercel

The widget is a static HTML app located at `web/widget/`.

```bash
cd web/widget
vercel deploy --prod
```

After deployment:
1. Copy the Vercel URL (e.g., `https://ind-acq-widget.vercel.app`)
2. Update `WIDGET_PUBLIC_URL` in Render's MCP Server environment variables

---

## Deployment Checklist

Use this checklist when deploying to production or staging:

### Pre-deployment
- [ ] All tests pass locally (`./scripts/regression-test.sh`)
- [ ] Environment variables documented in `.env.example` files
- [ ] No secrets in codebase (check `.gitignore`)
- [ ] Docker builds successfully for Excel Engine and MCP Server

### Render Deployment
1. [ ] Push changes to main branch
2. [ ] Render Blueprint creates/updates services automatically
3. [ ] Configure environment variables in Render Dashboard:
   - [ ] Excel Engine: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_BUCKET_ID
   - [ ] MCP Server: WIDGET_PUBLIC_URL (after Vercel deploy)
4. [ ] Verify health endpoints:
   - [ ] `curl https://excel-engine-xxx.onrender.com/health`
   - [ ] `curl https://mcp-server-xxx.onrender.com/health`
5. [ ] Test B2 upload: `curl https://excel-engine-xxx.onrender.com/debug/b2`

### Vercel Deployment
1. [ ] Deploy widget: `cd web/widget && vercel deploy --prod`
2. [ ] Copy Vercel URL
3. [ ] Update WIDGET_PUBLIC_URL in Render MCP Server
4. [ ] Verify widget loads in browser

### Post-deployment Verification
- [ ] Run smoke test from widget: Validate → Run Underwrite → Download Excel
- [ ] Verify download URL works and hasn't expired
- [ ] Check logs for errors in Render Dashboard

### Rollback Procedure
1. Go to Render Dashboard → Deploys
2. Select the previous working deployment
3. Click "Redeploy"

---

## Environment Variables

### Excel Engine

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 5001 | HTTP server port |
| `ASPNETCORE_URLS` | No | http://0.0.0.0:5001 | ASP.NET binding |
| `B2_KEY_ID` | No | - | Backblaze Application Key ID |
| `B2_APPLICATION_KEY` | No | - | Backblaze Application Key |
| `B2_BUCKET` | No | - | Backblaze bucket name |
| `B2_BUCKET_ID` | No | - | Backblaze bucket ID |
| `B2_DOWNLOAD_URL` | No | (auto) | Override download URL base |
| `B2_AUTH_CACHE_TTL_SECONDS` | No | 3600 | Auth token cache duration (seconds) |
| `B2_DOWNLOAD_AUTH_TTL_SECONDS` | No | 3600 | Download URL expiration (seconds) |

### MCP Server

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 8000 | HTTP server port |
| `NODE_ENV` | No | development | Node environment |
| `EXCEL_ENGINE_BASE_URL` | No | http://localhost:5001 | Excel engine URL |
| `WIDGET_PUBLIC_URL` | No | http://localhost:3001 | Widget URL for CSP/iframe |
| `CONTRACTS_DIR` | No | (auto) | Path to contracts directory |

### Widget (Vercel)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_MCP_URL` | Yes | - | MCP server URL (Render) |

---

## Backblaze B2 Setup

> **Note**: We use the Backblaze B2 **native API** instead of S3-compatible API for reliability.
> The S3-compatible API had persistent signature validation issues.

### 1. Create a Bucket

1. Log in to [Backblaze B2 Console](https://secure.backblaze.com/b2_buckets.htm)
2. Click **Create a Bucket**
3. Bucket name: `your-bucket-name` (e.g., `magnolia-os-uploads`)
4. Files in bucket: **Private** (recommended) or **Public**
5. Save - note the **Bucket ID** shown in the bucket details

> **Note**: Private buckets are supported. The Excel Engine generates time-limited
> authorized download URLs using B2's `b2_get_download_authorization` API.
> URL expiration is configurable via `B2_DOWNLOAD_AUTH_TTL_SECONDS` (default: 1 hour).

### 2. Create Application Key

1. Go to **App Keys** → **Add a New Application Key**
2. Name: `excel-engine-prod`
3. Allow access to bucket: Select your bucket
4. Type of Access: **Read and Write**
5. File name prefix: Leave empty
6. Duration: Leave default (permanent)
7. Click **Create New Key**
8. **IMMEDIATELY copy both values** (Application Key is only shown once!):
   - `keyID` → This is your `B2_KEY_ID`
   - `applicationKey` → This is your `B2_APPLICATION_KEY`

### 3. Verify Credentials Work

```bash
# Test B2 native API authorization
curl -s https://api.backblazeb2.com/b2api/v2/b2_authorize_account \
  -u "YOUR_KEY_ID:YOUR_APPLICATION_KEY"
```

You should see a JSON response with:
```json
{
  "accountId": "...",
  "apiUrl": "https://api005.backblazeb2.com",
  "authorizationToken": "...",
  "downloadUrl": "https://f005.backblazeb2.com",
  ...
}
```

If you get `{"code": "unauthorized", "status": 401}`, the credentials are invalid.

### 4. Configure Environment Variables

For local development:
```bash
export B2_KEY_ID="005b77abe9b22e30000000001"
export B2_APPLICATION_KEY="K005xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export B2_BUCKET="magnolia-os-uploads"
export B2_BUCKET_ID="4a5b6c7d8e9f0a1b2c3d4e5f"
```

For Render:
1. Go to your Excel Engine service in Render Dashboard
2. Go to **Environment** tab
3. Add the 4 required variables above

### 5. Test Upload

After configuring, test the B2 integration:

```bash
# Start Excel Engine with B2 credentials
cd services/excel-engine
B2_KEY_ID=... B2_APPLICATION_KEY=... B2_BUCKET=... B2_BUCKET_ID=... dotnet run

# In another terminal, test the debug endpoint
curl http://localhost:5001/debug/b2 | jq
```

Expected response:
```json
{
  "status": "ok",
  "message": "B2 upload test successful",
  "file_name": "test/debug-20251222-123456.txt",
  "download_url": "https://f005.backblazeb2.com/file/magnolia-os-uploads/test/debug-20251222-123456.txt?Authorization=...",
  "expires_at": "2025-12-22T13:34:56.789Z",
  "file_id": "4_z..."
}
```

The `download_url` includes an authorization token for private bucket access, and `expires_at` indicates when the token expires.

### Fallback Behavior

When B2 variables are not configured, Excel Engine returns local file paths only. The `download_url` field will be null.

---

## Docker Build (Manual)

### Excel Engine (.NET 8)
```bash
cd services/excel-engine
docker build -t excel-engine .
docker run -p 5001:5001 \
  -e B2_KEY_ID="..." \
  -e B2_APPLICATION_KEY="..." \
  -e B2_BUCKET="..." \
  -e B2_BUCKET_ID="..." \
  excel-engine
```

### MCP Server
```bash
# Build from repo root (needs contracts/)
docker build -f services/mcp-server/Dockerfile -t mcp-server .
docker run -p 8000:8000 \
  -e EXCEL_ENGINE_BASE_URL=http://host.docker.internal:5001 \
  -e WIDGET_PUBLIC_URL=https://your-widget.vercel.app \
  mcp-server
```

---

## Health Checks

```bash
# Excel Engine
curl http://localhost:5001/health

# Excel Engine version (shows b2_enabled status)
curl http://localhost:5001/version

# MCP Server
curl http://localhost:8000/health
```

---

## Troubleshooting

### .NET 8 not found
Install .NET 8 LTS:
- macOS: `brew install dotnet@8`
- Linux: https://learn.microsoft.com/en-us/dotnet/core/install/linux
- Windows: https://dotnet.microsoft.com/download/dotnet/8.0

### EPPlus license warning
Set environment variable:
```bash
export EPPlus__ExcelPackage__LicenseContext=NonCommercial
```

### B2 upload fails with "unauthorized"

1. **Verify credentials work:**
```bash
curl -s https://api.backblazeb2.com/b2api/v2/b2_authorize_account \
  -u "YOUR_KEY_ID:YOUR_APPLICATION_KEY"
```

2. **Check all 4 required variables are set:**
   - `B2_KEY_ID`
   - `B2_APPLICATION_KEY`
   - `B2_BUCKET`
   - `B2_BUCKET_ID`

3. **Verify bucket ID is correct:**
   - Go to B2 Console → Buckets
   - Click on your bucket
   - Copy the "Bucket ID" (not the bucket name)

4. **Create a new Application Key if needed:**
   - Keys are only shown once at creation
   - Create a new key and copy both values immediately

### B2 download URL not working

1. Check the download URL format: `https://f005.backblazeb2.com/file/BUCKET_NAME/path/to/file?Authorization=TOKEN`
2. Verify the file was actually uploaded (check B2 Console → Browse Files)
3. For private buckets, ensure the URL includes `?Authorization=` parameter
4. Check if the download token has expired (configurable via `B2_DOWNLOAD_AUTH_TTL_SECONDS`)

### Migration from S3-compatible to B2 Native

If you were previously using S3-compatible API (S3_ENDPOINT, S3_ACCESS_KEY_ID, etc.):

1. Remove old S3 environment variables:
   - `S3_ENDPOINT`
   - `S3_REGION`
   - `S3_BUCKET`
   - `S3_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY`
   - `SIGNED_URL_TTL_SECONDS`

2. Add new B2 native variables:
   - `B2_KEY_ID`
   - `B2_APPLICATION_KEY`
   - `B2_BUCKET`
   - `B2_BUCKET_ID`

3. The Application Key ID and Key are the same values, just renamed.

**Why B2 Native?** The S3-compatible API had persistent "SignatureDoesNotMatch" errors
due to AWS SDK signature calculation incompatibilities. The B2 native API uses simple
HTTP Basic auth and works reliably.

---

## Golden PDF Fidelity Testing

The golden PDF fidelity test ensures generated XLSX files match the reference PDF layout and metrics.

### Reference PDF

- **Source**: `Industrial+Acquisition+Assumptions.pdf` (Top Shelf Models)
- **Location**: Repository root
- **Key Metrics**: Unlevered IRR 12.9%, Levered IRR 19.9%, Investor IRR 18.0%

### Pack Export Configuration

The investor pack export is defined in `docs/IND_ACQ_PACK_EXPORT.json`. This config specifies:
- Which sheets to include in the investor PDF
- Sheet ordering for the pack
- Expected page counts per sheet
- Print orientation settings

### IND_ACQ Pack V1 Sheets (11 pages - LOCKED)

| Order | Sheet Name | Pages | Orientation | Content |
|-------|------------|-------|-------------|---------|
| 1 | Investment Summary | 1 | Portrait | Key metrics, returns, deal highlights |
| 2 | Returns Summary | 1 | Portrait | IRR, multiples, sensitivity analysis |
| 3 | Error Check | 1 | Portrait | Model validation checks |
| 4 | Model Outputs | 1 | Portrait | Full outputs matrix |
| 5 | Annual CF | 1 | Landscape | Annual cash flow summary |
| 6 | Assumptions | 1 | Portrait | Deal assumptions and inputs |
| 7 | Rent Roll | 1 | Landscape | Tenant schedule with escalations |
| 8 | Renovation Budget | 1 | Portrait | Capex and renovation items |
| 9 | Monthly CF | 3 | Landscape | 60-month detailed cash flows |

**Total:** 11 pages (8 single-page sheets + 3-page Monthly CF)
**Tolerance:** 0 pages (strict)
**Pack Version:** `IND_ACQ_PACK_V1`

**Excluded Sheets:**
- `_TEMPLATE_META` - Internal template metadata

### Reference PDF Page Count Difference

> **Important**: The reference PDF (`Industrial+Acquisition+Assumptions.pdf`) from Top Shelf Models
> has 22 pages because it includes additional modules NOT in our IND_ACQ template:
> - LP/GP Waterfall calculations
> - Sale comps (market comparables)
> - Lease comps (lease benchmarking)
> - SOFR/rate schedules
> - Additional sensitivity/scenario analysis
>
> **Our pack has 11 pages by design.** This is correct and expected.
>
> Golden PDF testing uses **shared-page mapping** (`IND_ACQ_REFERENCE_PAGE_MAP.json`) to compare
> only pages that exist in both PDFs. This provides meaningful fidelity validation without
> requiring identical page counts.

### Layout Invariants

The Excel engine validates these layout invariants for PDF fidelity:

1. **Required Sheets**: Assumptions, Rent Roll, Monthly CF, Annual Cashflow, Investment Summary
2. **Print Areas**: Each sheet must have print area defined
3. **Freeze Panes**: Data sheets (Monthly CF, Rent Roll, Annual Cashflow) must have frozen headers
4. **Page Setup**:
   - Margins: 0.25" to 1.5" (reasonable range)
   - Paper Size: Letter or A4
   - Scaling: FitToPage or 50-100% scale
   - Orientation: Set appropriately per sheet

### Running Golden PDF Tests

```bash
# Requires LibreOffice (for XLSX→PDF) and ImageMagick (for pixel diff)
brew install --cask libreoffice
brew install imagemagick

# Run the golden PDF fidelity test (local mode)
./scripts/golden-pdf-compare.sh

# Run against staging (B2 configured)
MCP_URL=https://mcp-server-xxx.onrender.com ./scripts/golden-pdf-compare.sh

# Options:
./scripts/golden-pdf-compare.sh --skip-pixel-diff         # Skip visual comparison
./scripts/golden-pdf-compare.sh --require-pdf             # Fail if PDF cannot be generated
./scripts/golden-pdf-compare.sh --require-pagecount       # Fail if page count doesn't match (11 pages strict)
./scripts/golden-pdf-compare.sh --strict-reference-pages  # Fail if reference PDF page count differs
./scripts/golden-pdf-compare.sh --full-workbook           # Export all sheets (not pack only)
```

### Pack Export Workflow

The test generates PDFs and validates using shared-page mapping:

1. **Full workbook XLSX** - Generated from model (all 10 sheets, 273KB)
2. **Pack XLSX** - Extracted subset (9 investor sheets, 241KB)
3. **Pack PDF** - Converted from pack XLSX (exactly 11 pages)
4. **Shared-page comparison** - Only compares mapped pages vs reference PDF

**Page Count Validation:**
- Pack PDF must be exactly 11 pages (tolerance = 0)
- Reference PDF has 22 pages (includes modules we don't have)
- Default behavior: Compare shared pages only (no warning for page count difference)
- With `--strict-reference-pages`: Fail if page counts differ (use for debugging)

**Shared-Page Mapping:**
- Defined in `IND_ACQ_REFERENCE_PAGE_MAP.json`
- Currently maps 2 pages (Investment Summary, Assumptions)
- Conservative approach: Only map pages with high/medium confidence
- Pixel diff runs only on mapped pages for meaningful comparison

### Expanding the Pack (Future)

To add new modules to IND_ACQ_PACK_V1 (e.g., Waterfall, Comps):

1. **Add sheets to template** - Implement new Excel sheets
2. **Update pack config** - Add to `IND_ACQ_PACK_EXPORT.json` with page counts
3. **Increment pack version** - Change to `IND_ACQ_PACK_V2`
4. **Update page mapping** - Add new page mappings to `IND_ACQ_REFERENCE_PAGE_MAP.json`
5. **Update expected total** - Adjust `expected_total_pages` (keep `page_tolerance=0`)
6. **Re-run golden test** - Validate new pack generates correctly

**Note:** Pack versioning ensures deterministic testing as template evolves.

### Test Files

| File | Description |
|------|-------------|
| `testcases/ind_acq/golden_pdf_case.inputs.json` | Golden testcase matching reference PDF |
| `testcases/ind_acq/golden_pdf_case.expected.json` | Expected outputs with tolerances |
| `scripts/golden-pdf-compare.sh` | Test runner script |
| `docs/IND_ACQ_PACK_EXPORT.json` | Pack definition (V1: 11 pages, 9 sheets) |
| `docs/IND_ACQ_REFERENCE_PAGE_MAP.json` | Shared-page mapping for comparison |

### Expected Metrics and Tolerances

| Metric | Expected | Tolerance |
|--------|----------|-----------|
| Unlevered IRR | 12.9% | ±0.5% |
| Levered IRR | 19.9% | ±0.5% |
| Investor IRR | 18.0% | ±0.5% |
| Unlevered Multiple | 1.7x | ±0.05x |
| Levered Multiple | 2.3x | ±0.05x |
| Acquisition Price | $12,360,000 | exact |
| Renovation Costs | $6,531,000 | ±1% |

### Output Keys

The Excel engine outputs layout status:

```json
{
  "out.layout.status": "OK",
  "out.layout.warning_count": 0,
  "out.layout.warnings": ""
}
```

When layout issues are detected:

```json
{
  "out.layout.status": "WARNINGS",
  "out.layout.warning_count": 3,
  "out.layout.warnings": "Missing print area on sheet: Assumptions; Missing freeze panes on sheet: Monthly CF; ..."
}
```

### CI Integration

For CI pipelines, the golden PDF test can be run in metrics-only mode:

```bash
# Skip pixel diff (no LibreOffice required)
./scripts/golden-pdf-compare.sh --skip-pixel-diff
```

This validates:
- Model generates successfully
- Output metrics are within tolerance
- Layout invariants pass (sheets exist, print areas defined)

Full pixel diff testing is recommended for release validation.
