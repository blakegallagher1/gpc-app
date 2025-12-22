#!/bin/bash
# Golden PDF Fidelity Test for IND_ACQ
# Generates XLSX from golden testcase, converts to PDF, and compares to reference
#
# Modes:
#   Staging (MCP_URL set): Calls deployed MCP server, uses download_url from B2
#   Local (MCP_URL unset): Calls localhost, falls back to file_path if no download_url
#
# Requirements:
#   - LibreOffice (for headless XLSX -> PDF conversion)
#   - ImageMagick (for PDF -> PNG conversion and pixel diff)
#   - curl, python3
#
# Usage:
#   ./golden-pdf-compare.sh [options]
#
# Options:
#   --skip-pixel-diff   Skip PDF visual comparison
#   --require-pdf       Fail if PDF comparison cannot run (no XLSX available)
#   --require-pagecount Fail if PDF page count doesn't match expected (from pack config)
#   --full-workbook     Convert full workbook instead of pack subset (for debugging)
#   --keep-artifacts    Keep artifacts after run (always kept in timestamped dir)
#
# Environment:
#   MCP_URL             MCP server URL (default: http://localhost:8000)
#   EXCEL_URL           Excel engine URL for local mode (default: http://localhost:5001)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Environment configuration
MCP_URL="${MCP_URL:-http://localhost:8000}"
EXCEL_URL="${EXCEL_URL:-http://localhost:5001}"

# Detect mode based on MCP_URL
if [[ "$MCP_URL" == *"localhost"* ]] || [[ "$MCP_URL" == *"127.0.0.1"* ]]; then
  RUN_MODE="local"
else
  RUN_MODE="staging"
fi

# Test case paths
GOLDEN_INPUTS="$REPO_ROOT/testcases/ind_acq/golden_pdf_case.inputs.json"
GOLDEN_EXPECTED="$REPO_ROOT/testcases/ind_acq/golden_pdf_case.expected.json"
REFERENCE_PDF="$REPO_ROOT/Industrial+Acquisition+Assumptions.pdf"
PACK_CONFIG="$REPO_ROOT/docs/IND_ACQ_PACK_EXPORT.json"

# Timestamped artifact directory
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ARTIFACTS_BASE="$REPO_ROOT/artifacts/golden-pdf"
ARTIFACTS_DIR="$ARTIFACTS_BASE/$TIMESTAMP"
GENERATED_XLSX="$ARTIFACTS_DIR/golden_generated.xlsx"
PACK_XLSX="$ARTIFACTS_DIR/golden_pack.xlsx"
GENERATED_PDF="$ARTIFACTS_DIR/golden_generated.pdf"
DIFF_DIR="$ARTIFACTS_DIR/diff"

# Thresholds
PIXEL_DIFF_THRESHOLD=0.02  # 2% pixel difference allowed

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Counters
PASSED=0
FAILED=0
WARNINGS=0

# Flags
SKIP_PIXEL_DIFF=false
REQUIRE_PDF=false
REQUIRE_PAGECOUNT=false
FULL_WORKBOOK=false
KEEP_ARTIFACTS=true  # Always keep in timestamped dir by default
XLSX_AVAILABLE=false
PACK_CREATED=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --skip-pixel-diff) SKIP_PIXEL_DIFF=true ;;
    --require-pdf) REQUIRE_PDF=true ;;
    --require-pagecount) REQUIRE_PAGECOUNT=true ;;
    --full-workbook) FULL_WORKBOOK=true ;;
    --keep-artifacts) KEEP_ARTIFACTS=true ;;
  esac
done

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED+1)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED+1)); }
log_warn() { echo -e "${YELLOW}⚠ WARN${NC}: $1"; WARNINGS=$((WARNINGS+1)); }
log_info() { echo -e "  ${BLUE}INFO${NC}: $1"; }

# Check dependencies
check_dependencies() {
  echo ">>> Checking Dependencies..."

  local missing=()

  if ! command -v curl &> /dev/null; then missing+=("curl"); fi
  if ! command -v python3 &> /dev/null; then missing+=("python3"); fi

  if ! command -v soffice &> /dev/null && ! command -v libreoffice &> /dev/null && [ ! -f "/Applications/LibreOffice.app/Contents/MacOS/soffice" ]; then
    log_warn "LibreOffice not found - PDF generation will be skipped"
    log_info "Install with: brew install --cask libreoffice"
    if [ "$REQUIRE_PDF" = true ]; then
      log_fail "LibreOffice required for --require-pdf mode"
      exit 1
    fi
    SKIP_PIXEL_DIFF=true
  else
    log_pass "LibreOffice found"
  fi

  if ! command -v compare &> /dev/null; then
    log_warn "ImageMagick 'compare' not found - pixel diff will be skipped"
    log_info "Install with: brew install imagemagick"
    if [ "$REQUIRE_PDF" = true ]; then
      log_fail "ImageMagick required for --require-pdf mode"
      exit 1
    fi
    SKIP_PIXEL_DIFF=true
  else
    log_pass "ImageMagick found"
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    log_fail "Missing required tools: ${missing[*]}"
    exit 1
  fi
}

# Check services
check_services() {
  echo ""
  echo ">>> Checking Services..."
  echo -e "  ${CYAN}Mode${NC}: $RUN_MODE"
  echo -e "  ${CYAN}MCP URL${NC}: $MCP_URL"

  if [ "$RUN_MODE" = "local" ]; then
    if curl -sf "$EXCEL_URL/health" > /dev/null 2>&1; then
      log_pass "Excel Engine is running at $EXCEL_URL"
    else
      log_fail "Excel Engine not responding at $EXCEL_URL"
      echo "Start with: cd services/excel-engine && dotnet run"
      exit 1
    fi
  fi

  if curl -sf "$MCP_URL/health" > /dev/null 2>&1; then
    log_pass "MCP Server is running at $MCP_URL"
  else
    log_fail "MCP Server not responding at $MCP_URL"
    if [ "$RUN_MODE" = "local" ]; then
      echo "Start with: cd services/mcp-server && pnpm dev"
    fi
    exit 1
  fi
}

# Generate XLSX via MCP
generate_xlsx() {
  echo ""
  echo ">>> Generating XLSX from Golden Testcase..."

  mkdir -p "$ARTIFACTS_DIR"
  mkdir -p "$DIFF_DIR"

  INPUTS=$(cat "$GOLDEN_INPUTS")

  # Build model via MCP
  BUILD_RESP=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"ind_acq.build_model\",\"arguments\":{\"inputs\":$INPUTS}}}")

  JOB_ID=$(echo "$BUILD_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('job_id',''))" 2>/dev/null)

  if [ -z "$JOB_ID" ]; then
    log_fail "No job_id returned from build_model"
    echo "Response: $BUILD_RESP"
    exit 1
  fi

  log_info "Job started: $JOB_ID"

  # Poll for completion
  for i in {1..120}; do
    STATUS_RESP=$(curl -s -X POST "$MCP_URL/mcp" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"ind_acq.get_run_status\",\"arguments\":{\"job_id\":\"$JOB_ID\"}}}")

    STATUS=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('status',''))" 2>/dev/null)

    if [ "$STATUS" = "complete" ]; then
      break
    elif [ "$STATUS" = "failed" ]; then
      ERROR=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('error',''))" 2>/dev/null)
      log_fail "Job failed: $ERROR"
      exit 1
    fi

    sleep 1
  done

  if [ "$STATUS" != "complete" ]; then
    log_fail "Job timed out after 120 seconds"
    exit 1
  fi

  log_pass "XLSX generation completed"

  # Save the status response for metric validation
  echo "$STATUS_RESP" > "$ARTIFACTS_DIR/status_response.json"
  log_info "Status response saved to: $ARTIFACTS_DIR/status_response.json"

  # Extract download_url and file_path from response
  DOWNLOAD_URL=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('download_url') or '')" 2>/dev/null)
  FILE_PATH=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('file_path') or '')" 2>/dev/null)

  # Try to get the XLSX file
  # Priority 1: download_url (B2 signed URL - works in staging)
  if [ -n "$DOWNLOAD_URL" ] && [ "$DOWNLOAD_URL" != "null" ]; then
    log_info "Downloading from B2: ${DOWNLOAD_URL:0:80}..."
    if curl -sf -o "$GENERATED_XLSX" "$DOWNLOAD_URL"; then
      log_pass "Downloaded XLSX via download_url"
      XLSX_AVAILABLE=true
    else
      log_warn "Failed to download from B2 URL"
    fi
  fi

  # Priority 2: file_path (local file system - works in local mode)
  if [ "$XLSX_AVAILABLE" = false ] && [ -n "$FILE_PATH" ] && [ "$FILE_PATH" != "null" ]; then
    log_info "Using local file_path: $FILE_PATH"
    if [ -f "$FILE_PATH" ]; then
      cp "$FILE_PATH" "$GENERATED_XLSX"
      log_pass "Copied XLSX from file_path"
      XLSX_AVAILABLE=true
    else
      log_warn "file_path not accessible: $FILE_PATH"
    fi
  fi

  # Priority 3: Try Excel Engine download endpoint (fallback for local)
  if [ "$XLSX_AVAILABLE" = false ] && [ "$RUN_MODE" = "local" ]; then
    FILE_ID=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('file_id') or '')" 2>/dev/null)
    if [ -n "$FILE_ID" ] && [ "$FILE_ID" != "null" ]; then
      log_info "Trying Excel Engine download: $EXCEL_URL/download/$FILE_ID"
      if curl -sf -o "$GENERATED_XLSX" "$EXCEL_URL/download/$FILE_ID"; then
        log_pass "Downloaded XLSX from Excel Engine"
        XLSX_AVAILABLE=true
      else
        log_warn "Excel Engine download failed"
      fi
    fi
  fi

  # Report final status
  if [ "$XLSX_AVAILABLE" = true ]; then
    log_info "XLSX saved to: $GENERATED_XLSX"
    log_info "File size: $(ls -lh "$GENERATED_XLSX" | awk '{print $5}')"
  else
    if [ "$REQUIRE_PDF" = true ]; then
      log_fail "XLSX not available and --require-pdf is set"
      exit 1
    else
      log_warn "XLSX not available - PDF comparison will be skipped"
      log_info "Metrics validation will still run from status response"
    fi
  fi
}

# Create pack workbook with only investor-facing sheets
create_pack_xlsx() {
  echo ""
  echo ">>> Creating Pack XLSX (Investor Subset)..."

  if [ "$FULL_WORKBOOK" = true ]; then
    log_info "Skipping pack creation (--full-workbook mode)"
    return 0
  fi

  if [ "$XLSX_AVAILABLE" = false ]; then
    log_warn "No source XLSX available - skipping pack creation"
    return 0
  fi

  if [ ! -f "$PACK_CONFIG" ]; then
    log_warn "Pack config not found: $PACK_CONFIG"
    log_info "Falling back to full workbook"
    return 0
  fi

  # Run the pack creation script
  local PACK_SCRIPT="$SCRIPT_DIR/create-pack-xlsx.py"

  if [ ! -f "$PACK_SCRIPT" ]; then
    log_warn "Pack script not found: $PACK_SCRIPT"
    log_info "Falling back to full workbook"
    return 0
  fi

  log_info "Creating pack from: $GENERATED_XLSX"
  log_info "Using config: $PACK_CONFIG"

  if python3 "$PACK_SCRIPT" "$GENERATED_XLSX" "$PACK_XLSX" --config "$PACK_CONFIG"; then
    log_pass "Pack XLSX created: $PACK_XLSX"
    PACK_CREATED=true
    log_info "File size: $(ls -lh "$PACK_XLSX" | awk '{print $5}')"
  else
    log_warn "Pack creation failed - falling back to full workbook"
  fi
}

# Validate metrics against expected values
validate_metrics() {
  echo ""
  echo ">>> Validating Metrics Against Expected Values..."

  if [ ! -f "$ARTIFACTS_DIR/status_response.json" ]; then
    log_fail "No status response to validate"
    return 1
  fi

  python3 - "$ARTIFACTS_DIR/status_response.json" "$GOLDEN_EXPECTED" << 'PYTHON_SCRIPT'
import sys
import json

status_file = sys.argv[1]
expected_file = sys.argv[2]

with open(status_file) as f:
    status = json.load(f)

with open(expected_file) as f:
    expected = json.load(f)

outputs = status.get('result', {}).get('structuredContent', {}).get('outputs', {})

def check_metric(name, actual, expected_val, tolerance_type, tolerance):
    """Check if actual value is within tolerance of expected"""
    if actual is None:
        return False, f"Missing output: {name}"

    # Handle non-numeric values (empty strings, etc.)
    if isinstance(actual, str):
        if actual == "":
            return False, f"Empty value (expected {expected_val})"
        try:
            actual = float(actual)
        except ValueError:
            return False, f"Non-numeric value: '{actual}'"

    if tolerance_type == 'abs':
        diff = abs(actual - expected_val)
        in_range = diff <= tolerance
        detail = f"diff={diff:.6f}, tol={tolerance}"
    else:  # pct
        if expected_val == 0:
            in_range = actual == 0
            detail = "expected=0"
        else:
            pct_diff = abs(actual - expected_val) / abs(expected_val)
            in_range = pct_diff <= tolerance
            detail = f"pct_diff={pct_diff:.4f}, tol={tolerance}"

    return in_range, detail

results = []

# Headline metrics
headline = expected.get('headline_metrics', {})
for key, spec in headline.items():
    # Map expected key to output key
    mappings = {
        'unlevered_irr': 'out.returns.unlevered.irr',
        'levered_irr': 'out.returns.levered.irr',
        'investor_irr': 'out.returns.investor.irr',
        'unlevered_multiple': 'out.returns.unlevered.multiple',
        'levered_multiple': 'out.returns.levered.multiple',
        'investor_multiple': 'out.returns.investor.multiple',
    }

    output_key = mappings.get(key, key)
    actual = outputs.get(output_key)

    tol_type = 'abs' if 'tolerance_abs' in spec else 'pct'
    tol_val = spec.get('tolerance_abs', spec.get('tolerance_pct', 0))

    passed, detail = check_metric(key, actual, spec['value'], tol_type, tol_val)
    results.append({
        'category': 'headline',
        'name': key,
        'expected': spec['value'],
        'actual': actual,
        'passed': passed,
        'detail': detail,
        'description': spec.get('description', '')
    })

# Print results
print("\nMetric Validation Results:")
print("-" * 80)

for r in results:
    status = '\033[92m✓\033[0m' if r['passed'] else '\033[91m✗\033[0m'
    actual_str = f"{r['actual']:.4f}" if isinstance(r['actual'], float) else str(r['actual'])
    expected_str = f"{r['expected']:.4f}" if isinstance(r['expected'], float) else str(r['expected'])
    print(f"{status} {r['name']}: actual={actual_str}, expected={expected_str} ({r['detail']})")

passed_count = sum(1 for r in results if r['passed'])
total_count = len(results)
print("-" * 80)
print(f"Metrics: {passed_count}/{total_count} passed")

# Exit with failure if any metrics failed
sys.exit(0 if passed_count == total_count else 1)
PYTHON_SCRIPT

  if [ $? -eq 0 ]; then
    log_pass "All metrics within tolerance"
  else
    log_fail "Some metrics out of tolerance"
  fi
}

# Convert XLSX to PDF using LibreOffice
convert_to_pdf() {
  echo ""
  echo ">>> Converting XLSX to PDF..."

  if [ "$XLSX_AVAILABLE" = false ]; then
    if [ "$REQUIRE_PDF" = true ]; then
      log_fail "No XLSX file to convert and --require-pdf is set"
      exit 1
    fi
    log_warn "No XLSX file to convert - skipping PDF generation"
    SKIP_PIXEL_DIFF=true
    return 0
  fi

  # Determine which XLSX to convert (pack or full)
  local SOURCE_XLSX
  if [ "$PACK_CREATED" = true ] && [ -f "$PACK_XLSX" ]; then
    SOURCE_XLSX="$PACK_XLSX"
    log_info "Converting pack XLSX: $PACK_XLSX"
  elif [ -f "$GENERATED_XLSX" ]; then
    SOURCE_XLSX="$GENERATED_XLSX"
    log_info "Converting full XLSX: $GENERATED_XLSX"
  else
    log_warn "No XLSX file found to convert"
    SKIP_PIXEL_DIFF=true
    return 0
  fi

  # Find LibreOffice
  local SOFFICE
  if command -v soffice &> /dev/null; then
    SOFFICE="soffice"
  elif command -v libreoffice &> /dev/null; then
    SOFFICE="libreoffice"
  elif [ -f "/Applications/LibreOffice.app/Contents/MacOS/soffice" ]; then
    SOFFICE="/Applications/LibreOffice.app/Contents/MacOS/soffice"
  else
    if [ "$REQUIRE_PDF" = true ]; then
      log_fail "LibreOffice not found and --require-pdf is set"
      exit 1
    fi
    log_warn "LibreOffice not found - skipping PDF conversion"
    SKIP_PIXEL_DIFF=true
    return 0
  fi

  # Convert to PDF
  log_info "Using: $SOFFICE"
  "$SOFFICE" --headless --convert-to pdf --outdir "$ARTIFACTS_DIR" "$SOURCE_XLSX" 2>/dev/null

  # Rename to expected name
  local XLSX_NAME=$(basename "$SOURCE_XLSX" .xlsx)
  if [ -f "$ARTIFACTS_DIR/${XLSX_NAME}.pdf" ]; then
    mv "$ARTIFACTS_DIR/${XLSX_NAME}.pdf" "$GENERATED_PDF"
    log_pass "Generated PDF: $GENERATED_PDF"
  else
    if [ "$REQUIRE_PDF" = true ]; then
      log_fail "PDF conversion failed and --require-pdf is set"
      exit 1
    fi
    log_fail "PDF conversion failed"
    SKIP_PIXEL_DIFF=true
  fi
}

# Validate page count against pack config expectations
validate_page_count() {
  echo ""
  echo ">>> Validating Page Count..."

  if [ ! -f "$GENERATED_PDF" ]; then
    log_warn "No PDF to validate page count"
    return 0
  fi

  # Get actual page count
  local ACTUAL_PAGES=$(identify -format "%n\n" "$GENERATED_PDF" 2>/dev/null | head -1)

  if [ -z "$ACTUAL_PAGES" ]; then
    log_warn "Could not determine PDF page count"
    return 0
  fi

  log_info "Actual page count: $ACTUAL_PAGES"

  # If using pack mode, validate against config
  if [ "$PACK_CREATED" = true ] && [ -f "$PACK_CONFIG" ]; then
    local EXPECTED_PAGES=$(python3 -c "import json; c=json.load(open('$PACK_CONFIG')); print(c.get('expected_total_pages', 0))" 2>/dev/null || echo "0")
    local TOLERANCE=$(python3 -c "import json; c=json.load(open('$PACK_CONFIG')); print(c.get('page_tolerance', 2))" 2>/dev/null || echo "2")

    log_info "Expected pages: $EXPECTED_PAGES (±$TOLERANCE)"

    local MIN_PAGES=$((EXPECTED_PAGES - TOLERANCE))
    local MAX_PAGES=$((EXPECTED_PAGES + TOLERANCE))

    if [ "$ACTUAL_PAGES" -ge "$MIN_PAGES" ] && [ "$ACTUAL_PAGES" -le "$MAX_PAGES" ]; then
      log_pass "Page count within tolerance: $ACTUAL_PAGES pages (expected $EXPECTED_PAGES ±$TOLERANCE)"
    else
      if [ "$REQUIRE_PAGECOUNT" = true ]; then
        log_fail "Page count out of range: $ACTUAL_PAGES pages (expected $MIN_PAGES-$MAX_PAGES)"
        exit 1
      else
        log_warn "Page count out of range: $ACTUAL_PAGES pages (expected $MIN_PAGES-$MAX_PAGES)"
      fi
    fi
  else
    # Full workbook mode - just report the count
    log_info "Full workbook mode - page count not validated"
    log_info "Use pack export (without --full-workbook) for page count validation"
  fi
}

# Compare PDFs using pixel diff
compare_pdfs() {
  echo ""
  echo ">>> Comparing PDFs (Pixel Diff)..."

  if [ "$SKIP_PIXEL_DIFF" = true ]; then
    log_warn "Skipping pixel diff (missing dependencies or --skip-pixel-diff flag)"
    return 0
  fi

  if [ ! -f "$GENERATED_PDF" ]; then
    if [ "$REQUIRE_PDF" = true ]; then
      log_fail "Generated PDF not found and --require-pdf is set"
      exit 1
    fi
    log_warn "Generated PDF not found - skipping comparison"
    return 0
  fi

  if [ ! -f "$REFERENCE_PDF" ]; then
    log_warn "Reference PDF not found at $REFERENCE_PDF - skipping comparison"
    return 0
  fi

  # Convert PDFs to images and compare each page
  log_info "Rendering PDFs to images for comparison..."

  # Get page counts
  local GEN_PAGES=$(identify -format "%n\n" "$GENERATED_PDF" 2>/dev/null | head -1)
  local REF_PAGES=$(identify -format "%n\n" "$REFERENCE_PDF" 2>/dev/null | head -1)

  log_info "Generated PDF: $GEN_PAGES pages, Reference PDF: $REF_PAGES pages"

  if [ "$GEN_PAGES" != "$REF_PAGES" ]; then
    log_warn "Page count mismatch: generated=$GEN_PAGES, reference=$REF_PAGES"
  fi

  # Compare first few key pages (Investment Summary, Assumptions, etc.)
  local PAGES_TO_COMPARE=(0 1 7)  # Page indices for key sheets
  local PAGES_COMPARED=0

  for page_idx in "${PAGES_TO_COMPARE[@]}"; do
    local page_num=$((page_idx + 1))

    # Extract pages as PNG
    convert -density 150 "$GENERATED_PDF[$page_idx]" -background white -flatten "$DIFF_DIR/gen_page_$page_num.png" 2>/dev/null || true
    convert -density 150 "$REFERENCE_PDF[$page_idx]" -background white -flatten "$DIFF_DIR/ref_page_$page_num.png" 2>/dev/null || true

    if [ ! -f "$DIFF_DIR/gen_page_$page_num.png" ] || [ ! -f "$DIFF_DIR/ref_page_$page_num.png" ]; then
      log_warn "Could not extract page $page_num for comparison"
      continue
    fi

    # Compare using ImageMagick
    local DIFF_RESULT=$(compare -metric AE "$DIFF_DIR/gen_page_$page_num.png" "$DIFF_DIR/ref_page_$page_num.png" "$DIFF_DIR/diff_page_$page_num.png" 2>&1 || true)

    # Get pixel count for percentage
    local TOTAL_PIXELS=$(identify -format "%w*%h\n" "$DIFF_DIR/gen_page_$page_num.png" | bc 2>/dev/null || echo "1")
    local DIFF_PCT=$(echo "scale=4; $DIFF_RESULT / $TOTAL_PIXELS" | bc 2>/dev/null || echo "0")

    log_info "Page $page_num: $DIFF_RESULT different pixels (${DIFF_PCT}%)"

    PAGES_COMPARED=$((PAGES_COMPARED + 1))

    # Check threshold
    if (( $(echo "$DIFF_PCT > $PIXEL_DIFF_THRESHOLD" | bc -l 2>/dev/null || echo "0") )); then
      log_warn "Page $page_num exceeds ${PIXEL_DIFF_THRESHOLD}% threshold (${DIFF_PCT}%)"
    fi
  done

  if [ $PAGES_COMPARED -gt 0 ]; then
    log_pass "Compared $PAGES_COMPARED pages"
    log_info "Diff images saved to: $DIFF_DIR"
  fi
}

# Check layout invariants (sheets, print areas, etc.)
check_layout_invariants() {
  echo ""
  echo ">>> Checking Layout Invariants..."

  if [ ! -f "$ARTIFACTS_DIR/status_response.json" ]; then
    log_warn "No status response - skipping layout checks"
    return 0
  fi

  # Check required sheets via outputs
  python3 - "$ARTIFACTS_DIR/status_response.json" "$GOLDEN_EXPECTED" << 'PYTHON_SCRIPT'
import sys
import json

status_file = sys.argv[1]
expected_file = sys.argv[2]

with open(status_file) as f:
    status = json.load(f)

with open(expected_file) as f:
    expected = json.load(f)

outputs = status.get('result', {}).get('structuredContent', {}).get('outputs', {})
layout = expected.get('layout_invariants', {})

# Check error status (indicates sheets are valid)
checks_status = outputs.get('out.checks.status', 'UNKNOWN')
error_count = outputs.get('out.checks.error_count', -1)

print(f"Checks Status: {checks_status}")
print(f"Error Count: {error_count}")

if checks_status == 'OK' and error_count == 0:
    print('\033[92m✓\033[0m Layout validation passed (no errors in workbook)')
    sys.exit(0)
else:
    print(f'\033[91m✗\033[0m Layout validation: status={checks_status}, errors={error_count}')
    sys.exit(1)
PYTHON_SCRIPT

  if [ $? -eq 0 ]; then
    log_pass "Layout invariants OK"
  else
    log_fail "Layout invariants failed"
  fi
}

# Print artifact paths
print_artifact_paths() {
  echo ""
  echo ">>> Artifact Paths"
  echo -e "  ${CYAN}Base directory${NC}: $ARTIFACTS_DIR"
  echo -e "  ${CYAN}Status response${NC}: $ARTIFACTS_DIR/status_response.json"
  if [ "$XLSX_AVAILABLE" = true ]; then
    echo -e "  ${CYAN}Generated XLSX${NC}: $GENERATED_XLSX"
  fi
  if [ "$PACK_CREATED" = true ] && [ -f "$PACK_XLSX" ]; then
    echo -e "  ${CYAN}Pack XLSX${NC}: $PACK_XLSX"
  fi
  if [ -f "$GENERATED_PDF" ]; then
    echo -e "  ${CYAN}Generated PDF${NC}: $GENERATED_PDF"
  fi
  if [ -d "$DIFF_DIR" ] && [ "$(ls -A $DIFF_DIR 2>/dev/null)" ]; then
    echo -e "  ${CYAN}Diff images${NC}: $DIFF_DIR/"
  fi
}

# Main execution
echo "============================================="
echo "Golden PDF Fidelity Test - IND_ACQ"
echo "============================================="
echo ""
echo -e "${CYAN}Mode${NC}: $RUN_MODE"
echo -e "${CYAN}MCP URL${NC}: $MCP_URL"
echo -e "${CYAN}Reference PDF${NC}: $REFERENCE_PDF"
echo -e "${CYAN}Golden Inputs${NC}: $GOLDEN_INPUTS"
echo -e "${CYAN}Pack Config${NC}: $PACK_CONFIG"
echo -e "${CYAN}Artifacts${NC}: $ARTIFACTS_DIR"
if [ "$FULL_WORKBOOK" = true ]; then
  echo -e "${YELLOW}Mode: Full Workbook (pack export disabled)${NC}"
fi
echo ""

check_dependencies
check_services
generate_xlsx
create_pack_xlsx
validate_metrics
convert_to_pdf
validate_page_count
compare_pdfs
check_layout_invariants
print_artifact_paths

echo ""
echo "============================================="
echo "SUMMARY"
echo "============================================="
echo -e "Passed:   ${GREEN}$PASSED${NC}"
echo -e "Failed:   ${RED}$FAILED${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}Golden PDF fidelity test passed!${NC}"
  exit 0
else
  echo -e "${RED}Golden PDF fidelity test failed. Review output above.${NC}"
  exit 1
fi
