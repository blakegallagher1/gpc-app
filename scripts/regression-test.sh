#!/bin/bash
# IND_ACQ Regression & Sanity Test Suite
# Runs E2E tests and validates output ranges

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_URL="${MCP_URL:-http://localhost:8000}"
EXCEL_URL="${EXCEL_URL:-http://localhost:5001}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Counters
PASSED=0
FAILED=0
WARNINGS=0

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED+1)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED+1)); }
log_warn() { echo -e "${YELLOW}⚠ WARN${NC}: $1"; WARNINGS=$((WARNINGS+1)); }
log_info() { echo -e "  INFO: $1"; }

check_range() {
  local name="$1"
  local value="$2"
  local min="$3"
  local max="$4"

  if [ -z "$value" ] || [ "$value" = "null" ]; then
    log_fail "$name is missing or null"
    return 1
  fi

  local in_range=$(python3 -c "v=$value; print('1' if $min <= v <= $max else '0')")
  if [ "$in_range" = "1" ]; then
    log_pass "$name = $value (expected: $min to $max)"
    return 0
  else
    log_fail "$name = $value (expected: $min to $max)"
    return 1
  fi
}

check_equals() {
  local name="$1"
  local actual="$2"
  local expected="$3"

  if [ "$actual" = "$expected" ]; then
    log_pass "$name = $actual"
    return 0
  else
    log_fail "$name = $actual (expected: $expected)"
    return 1
  fi
}

echo "============================================="
echo "IND_ACQ Regression Test Suite"
echo "============================================="
echo ""

# Check services
echo ">>> Checking Services..."
if curl -sf "$EXCEL_URL/health" > /dev/null 2>&1; then
  log_pass "Excel Engine is running at $EXCEL_URL"
else
  log_fail "Excel Engine not responding at $EXCEL_URL"
  echo "Start with: cd services/excel-engine && dotnet run"
  exit 1
fi

if curl -sf "$MCP_URL/health" > /dev/null 2>&1; then
  log_pass "MCP Server is running at $MCP_URL"
else
  log_fail "MCP Server not responding at $MCP_URL"
  echo "Start with: cd services/mcp-server && pnpm dev"
  exit 1
fi

echo ""
echo ">>> Running case_001 (Industrial Acquisition)..."

INPUTS=$(cat "$REPO_ROOT/testcases/ind_acq/case_001.inputs.json")

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
for i in {1..60}; do
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
  log_fail "Job timed out after 60 seconds"
  exit 1
fi

log_pass "Job completed successfully"

# Extract outputs using Python to create proper bash variable assignments
eval "$(echo "$STATUS_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sc = d.get('result',{}).get('structuredContent',{})
outputs = sc.get('outputs', {})
for k, v in outputs.items():
    # Convert dots to underscores only in the key name
    safe_key = 'OUT_' + k.replace('.', '_')
    # Quote the value properly
    if isinstance(v, str):
        print(f'{safe_key}=\"{v}\"')
    else:
        print(f'{safe_key}={v}')
")"

echo ""
echo ">>> Validating Sanity Checks..."

# Check status
check_equals "checks.status" "$OUT_out_checks_status" "OK"
check_equals "checks.error_count" "$OUT_out_checks_error_count" "0"

echo ""
echo ">>> Validating Return Ranges..."

# Unlevered IRR: 8-18%
check_range "Unlevered IRR" "$OUT_out_returns_unlevered_irr" 0.08 0.18

# Levered IRR: 12-25%
check_range "Levered IRR" "$OUT_out_returns_levered_irr" 0.12 0.25

# Equity Multiple: 1.0-2.5x
check_range "Equity Multiple" "$OUT_out_returns_levered_multiple" 1.0 2.5

echo ""
echo ">>> Validating Operational Metrics..."

# EGI Year 1: $400K - $700K for 50K SF industrial
check_range "EGI Year 1" "$OUT_out_operations_egi_year1" 400000 700000

# NOI Year 1: $300K - $500K
check_range "NOI Year 1" "$OUT_out_operations_noi_year1" 300000 500000

echo ""
echo ">>> Validating Debt/Exit Metrics..."

# Loan Amount: 65% LTV of $4.5M = ~$2.9M
check_range "Loan Amount" "$OUT_out_debt_acq_loan_amount_sized" 2500000 3500000

# Exit Proceeds: > $5M for 5-year hold
check_range "Exit Net Proceeds" "$OUT_out_exit_net_sale_proceeds" 5000000 8000000

echo ""
echo ">>> Checking Download URL Support..."

DOWNLOAD_URL=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('download_url') or 'null')" 2>/dev/null)
DOWNLOAD_EXPIRY=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('download_url_expiry') or 'null')" 2>/dev/null)
FILE_PATH=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('file_path') or 'null')" 2>/dev/null)

if [ "$DOWNLOAD_URL" != "null" ] && [ -n "$DOWNLOAD_URL" ]; then
  log_pass "Download URL present: ${DOWNLOAD_URL:0:60}..."
  if [ "$DOWNLOAD_EXPIRY" != "null" ]; then
    log_info "URL expires: $DOWNLOAD_EXPIRY"
  fi
else
  log_warn "Download URL not available (B2 not configured)"
fi

if [ "$FILE_PATH" != "null" ] && [ -n "$FILE_PATH" ]; then
  if [ -f "$FILE_PATH" ]; then
    log_pass "Output file exists: $FILE_PATH"
  else
    log_warn "Output file path returned but file not found (may be on remote)"
  fi
else
  log_fail "No file_path returned"
fi

echo ""
echo "============================================="
echo "SUMMARY"
echo "============================================="
echo -e "Passed:   ${GREEN}$PASSED${NC}"
echo -e "Failed:   ${RED}$FAILED${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All regression tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed. Review output above.${NC}"
  exit 1
fi
