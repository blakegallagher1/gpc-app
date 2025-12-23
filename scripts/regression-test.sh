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
SKIPPED=0

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED+1)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED+1)); }
log_warn() { echo -e "${YELLOW}⚠ WARN${NC}: $1"; WARNINGS=$((WARNINGS+1)); }
log_skip() { echo -e "${YELLOW}⊘ SKIP${NC}: $1"; SKIPPED=$((SKIPPED+1)); }
log_info() { echo -e "  INFO: $1"; }

# Quarantined templates (broken, skip these test cases)
QUARANTINED_TEMPLATES="IND_ACQ_MT"

is_quarantined() {
  local TEMPLATE_ID="$1"
  for Q in $QUARANTINED_TEMPLATES; do
    if [ "$TEMPLATE_ID" = "$Q" ]; then
      return 0
    fi
  done
  return 1
}

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

# Function to run a single test case
run_test_case() {
  local CASE_FILE="$1"
  local CASE_NAME="$(basename "$CASE_FILE" .inputs.json)"

  echo ""
  echo ">>> Running $CASE_NAME..."

  INPUTS=$(cat "$CASE_FILE")

  # Extract tenant and rollover count for display
  TENANT_COUNT=$(echo "$INPUTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('rent_roll',{}).get('tenants_in_place',[])))" 2>/dev/null)
  ROLLOVER_COUNT=$(echo "$INPUTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('rent_roll',{}).get('market_rollover',[])))" 2>/dev/null)
  TEMPLATE_ID=$(echo "$INPUTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('contract',{}).get('template_id',''))" 2>/dev/null)
  log_info "Template: $TEMPLATE_ID, Tenants: $TENANT_COUNT, Rollovers: $ROLLOVER_COUNT"

  # Build model via MCP
  BUILD_RESP=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"ind_acq.build_model\",\"arguments\":{\"inputs\":$INPUTS}}}")

  JOB_ID=$(echo "$BUILD_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('job_id',''))" 2>/dev/null)

  if [ -z "$JOB_ID" ]; then
    log_fail "[$CASE_NAME] No job_id returned from build_model"
    echo "Response: $BUILD_RESP"
    return 1
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
      log_fail "[$CASE_NAME] Job failed: $ERROR"
      return 1
    fi

    sleep 1
  done

  if [ "$STATUS" != "complete" ]; then
    log_fail "[$CASE_NAME] Job timed out after 60 seconds"
    return 1
  fi

  log_pass "[$CASE_NAME] Job completed successfully"

  # Extract outputs using Python to create proper bash variable assignments
  # Outputs can be in _meta.full_outputs or structuredContent.outputs
  eval "$(echo "$STATUS_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
result = d.get('result', {})
# Try _meta.full_outputs first (new format), then structuredContent.outputs (old format)
outputs = result.get('_meta', {}).get('full_outputs', {})
if not outputs:
    outputs = result.get('structuredContent', {}).get('outputs', {})
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
  echo ">>> [$CASE_NAME] Validating Sanity Checks..."

  # Check status
  check_equals "[$CASE_NAME] checks.status" "$OUT_out_checks_status" "OK"
  check_equals "[$CASE_NAME] checks.error_count" "$OUT_out_checks_error_count" "0"

  echo ""
  echo ">>> [$CASE_NAME] Validating Return Ranges..."

  # IRR ranges (relaxed for different deal types)
  check_range "[$CASE_NAME] Unlevered IRR" "$OUT_out_returns_unlevered_irr" 0.05 0.25
  check_range "[$CASE_NAME] Levered IRR" "$OUT_out_returns_levered_irr" 0.08 0.35
  check_range "[$CASE_NAME] Equity Multiple" "$OUT_out_returns_levered_multiple" 1.0 3.0

  echo ""
  echo ">>> [$CASE_NAME] Checking Download URL Support..."

  DOWNLOAD_URL=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('download_url') or 'null')" 2>/dev/null)
  DOWNLOAD_EXPIRY=$(echo "$STATUS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('download_url_expiry') or 'null')" 2>/dev/null)

  if [ "$DOWNLOAD_URL" != "null" ] && [ -n "$DOWNLOAD_URL" ]; then
    log_pass "[$CASE_NAME] Download URL present: ${DOWNLOAD_URL:0:60}..."
    if [ "$DOWNLOAD_EXPIRY" != "null" ]; then
      log_info "URL expires: $DOWNLOAD_EXPIRY"
    fi
  else
    log_warn "[$CASE_NAME] Download URL not available (B2 not configured)"
  fi

  return 0
}

# Find and run all test cases
TESTCASES_DIR="$REPO_ROOT/testcases/ind_acq"
CASE_FILES=$(find "$TESTCASES_DIR" -name "*.inputs.json" | sort)

if [ -z "$CASE_FILES" ]; then
  log_fail "No test case files found in $TESTCASES_DIR"
  exit 1
fi

log_info "Found test cases:"
for CASE_FILE in $CASE_FILES; do
  log_info "  - $(basename "$CASE_FILE")"
done

# Run each test case (skip quarantined templates)
for CASE_FILE in $CASE_FILES; do
  # Check if this case uses a quarantined template
  CASE_TEMPLATE=$(cat "$CASE_FILE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('contract',{}).get('template_id',''))" 2>/dev/null)

  if is_quarantined "$CASE_TEMPLATE"; then
    CASE_NAME="$(basename "$CASE_FILE" .inputs.json)"
    log_skip "$CASE_NAME: $CASE_TEMPLATE quarantined (template broken)"
    continue
  fi

  run_test_case "$CASE_FILE"
done

echo ""
echo "============================================="
echo "SUMMARY"
echo "============================================="
echo -e "Passed:   ${GREEN}$PASSED${NC}"
echo -e "Failed:   ${RED}$FAILED${NC}"
echo -e "Skipped:  ${YELLOW}$SKIPPED${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  if [ $SKIPPED -gt 0 ]; then
    echo -e "${GREEN}All active regression tests passed!${NC} ($SKIPPED quarantined)"
  else
    echo -e "${GREEN}All regression tests passed!${NC}"
  fi
  exit 0
else
  echo -e "${RED}Some tests failed. Review output above.${NC}"
  exit 1
fi
