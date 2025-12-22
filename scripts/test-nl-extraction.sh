#!/bin/bash
# NL Extraction Regression Test Suite
# Tests the build_model tool with mode="extract_only"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_URL="${MCP_URL:-http://localhost:8000}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Counters
PASSED=0
FAILED=0
SKIPPED=0

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED+1)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED+1)); }
log_skip() { echo -e "${YELLOW}⊘ SKIP${NC}: $1"; SKIPPED=$((SKIPPED+1)); }
log_info() { echo -e "  INFO: $1"; }

# Check if OPENAI_API_KEY is set
if [ -z "$OPENAI_API_KEY" ]; then
  echo -e "${YELLOW}Warning: OPENAI_API_KEY not set. NL extraction tests will be skipped.${NC}"
  SKIP_EXTRACTION=true
fi

echo "============================================="
echo "NL Extraction Regression Test Suite"
echo "============================================="
echo "Using build_model with mode='extract_only'"
echo ""

# Check MCP server
echo ">>> Checking MCP Server..."
if curl -sf "$MCP_URL/health" > /dev/null 2>&1; then
  log_pass "MCP Server is running at $MCP_URL"
else
  log_fail "MCP Server not responding at $MCP_URL"
  echo "Start with: cd services/mcp-server && pnpm dev"
  exit 1
fi

# Function to run a single extraction test
run_extraction_test() {
  local CASE_FILE="$1"
  local CASE_NAME="$(basename "$CASE_FILE" .json)"

  echo ""
  echo ">>> Running $CASE_NAME..."

  if [ "$SKIP_EXTRACTION" = true ]; then
    log_skip "[$CASE_NAME] OpenAI API key not configured"
    return 0
  fi

  # Read the prompt from the test case
  PROMPT=$(python3 -c "import json; print(json.load(open('$CASE_FILE'))['prompt'])")
  EXPECTED_STATUS=$(python3 -c "import json; d=json.load(open('$CASE_FILE')); print(d.get('expected_status', 'ok'))")

  log_info "Prompt: ${PROMPT:0:80}..."

  # Call build_model with mode="extract_only" via MCP
  RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"ind_acq.build_model\",\"arguments\":{\"natural_language\":$(echo "$PROMPT" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),\"mode\":\"extract_only\"}}}")

  # Extract status from response
  STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('structuredContent',{}).get('status',''))" 2>/dev/null)

  if [ -z "$STATUS" ]; then
    log_fail "[$CASE_NAME] No status returned"
    echo "Response: $RESPONSE"
    return 1
  fi

  log_info "Got status: $STATUS"

  # Check status matches expected
  if [ "$STATUS" = "$EXPECTED_STATUS" ]; then
    log_pass "[$CASE_NAME] Status matches expected: $STATUS"
  else
    log_fail "[$CASE_NAME] Expected status '$EXPECTED_STATUS', got '$STATUS'"
    return 1
  fi

  # If ok, validate some expected values
  if [ "$STATUS" = "ok" ]; then
    INPUTS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('result',{}).get('structuredContent',{}).get('inputs',{})))" 2>/dev/null)

    if [ "$INPUTS" != "{}" ] && [ -n "$INPUTS" ]; then
      log_pass "[$CASE_NAME] Inputs extracted successfully"

      # Check for expected fields
      EXPECTED_FIELDS=$(python3 -c "import json; d=json.load(open('$CASE_FILE')); print(' '.join(d.get('expected_extracted_fields', [])))" 2>/dev/null)

      for FIELD in $EXPECTED_FIELDS; do
        # Check if field exists in inputs (nested path)
        EXISTS=$(echo "$INPUTS" | python3 -c "
import sys, json
inputs = json.load(sys.stdin)
path = '$FIELD'.split('.')
current = inputs
try:
    for p in path:
        current = current[p]
    print('1' if current is not None else '0')
except:
    print('0')
")
        if [ "$EXISTS" = "1" ]; then
          log_pass "[$CASE_NAME] Field $FIELD extracted"
        else
          log_info "[$CASE_NAME] Field $FIELD not found (may be optional)"
        fi
      done
    else
      log_fail "[$CASE_NAME] No inputs in response"
    fi
  fi

  # If needs_info, check missing fields are reported
  if [ "$STATUS" = "needs_info" ]; then
    MISSING=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); mf=d.get('result',{}).get('structuredContent',{}).get('missing_fields',[]); print(len(mf))" 2>/dev/null)
    if [ "$MISSING" -gt 0 ]; then
      log_pass "[$CASE_NAME] Missing fields reported: $MISSING field(s)"
    else
      log_info "[$CASE_NAME] No missing fields listed"
    fi
  fi

  return 0
}

# Find and run all test cases
TESTCASES_DIR="$REPO_ROOT/testcases/nl_extraction"
CASE_FILES=$(find "$TESTCASES_DIR" -name "prompt_*.json" | sort)

if [ -z "$CASE_FILES" ]; then
  log_fail "No test case files found in $TESTCASES_DIR"
  exit 1
fi

log_info "Found test cases:"
for CASE_FILE in $CASE_FILES; do
  log_info "  - $(basename "$CASE_FILE")"
done

# Run each test case
for CASE_FILE in $CASE_FILES; do
  run_extraction_test "$CASE_FILE" || true
done

echo ""
echo "============================================="
echo "SUMMARY"
echo "============================================="
echo -e "Passed:  ${GREEN}$PASSED${NC}"
echo -e "Failed:  ${RED}$FAILED${NC}"
echo -e "Skipped: ${YELLOW}$SKIPPED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All NL extraction tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed. Review output above.${NC}"
  exit 1
fi
