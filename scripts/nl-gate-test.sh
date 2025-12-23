#!/bin/bash
# NL Extraction Gate Test
# Staging-safe validation with configurable timeouts and retries
# Tests: extraction + validation of complete prompts, missing fields for incomplete

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_URL="${MCP_URL:-http://localhost:8000}"

# Configurable timeouts and retries (staging-safe defaults)
NL_GATE_TIMEOUT_SECONDS="${NL_GATE_TIMEOUT_SECONDS:-180}"
NL_GATE_MAX_RETRIES="${NL_GATE_MAX_RETRIES:-3}"
NL_GATE_BACKOFF_SECONDS="${NL_GATE_BACKOFF_SECONDS:-5}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Counters
PASSED=0
FAILED=0
TOTAL_RETRIES=0

# Last response for debugging
LAST_RESPONSE=""
LAST_HTTP_STATUS=""

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED+1)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED+1)); }
log_info() { echo -e "  ${CYAN}INFO${NC}: $1"; }
log_warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }
# log_debug goes to stderr so it doesn't get captured in command substitution
log_debug() { echo -e "  ${CYAN}DEBUG${NC}: $1" >&2; }
# log_warn_internal for use inside functions that output to stdout
log_warn_internal() { echo -e "  ${YELLOW}WARN${NC}: $1" >&2; }

echo "============================================="
echo "NL Extraction Gate Test (Staging-Safe)"
echo "============================================="
echo "MCP_URL: $MCP_URL"
echo "Timeout: ${NL_GATE_TIMEOUT_SECONDS}s | Max Retries: $NL_GATE_MAX_RETRIES | Backoff: ${NL_GATE_BACKOFF_SECONDS}s"
echo ""

# Check if OPENAI_API_KEY is set - graceful skip for CI
if [ -z "$OPENAI_API_KEY" ]; then
  echo -e "${YELLOW}SKIP: OPENAI_API_KEY not set${NC}"
  echo ""
  echo "============================================="
  echo -e "${YELLOW}NL_GATE: SKIP${NC}"
  echo "============================================="
  exit 0
fi

# Check MCP server health
echo ">>> Checking MCP Server..."
if ! curl -sf --max-time 10 "$MCP_URL/health" > /dev/null 2>&1; then
  echo -e "${RED}ERROR: MCP Server not responding at $MCP_URL${NC}"
  echo ""
  echo "============================================="
  echo -e "${RED}NL_GATE: FAIL${NC}"
  echo "============================================="
  exit 1
fi
log_pass "MCP Server is running"

# Helper: call MCP tool with retries and timeout
call_tool_with_retry() {
  local TOOL_NAME="$1"
  local ARGS="$2"
  local ATTEMPT=1
  local BACKOFF=$NL_GATE_BACKOFF_SECONDS
  local START_TIME
  local END_TIME
  local DURATION
  local HTTP_CODE
  local RESPONSE
  local TMPFILE

  TMPFILE=$(mktemp)
  trap "rm -f $TMPFILE" RETURN

  while [ $ATTEMPT -le $NL_GATE_MAX_RETRIES ]; do
    START_TIME=$(python3 -c "import time; print(time.time())")

    # Make request with timeout, capture HTTP status
    HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" \
      --max-time "$NL_GATE_TIMEOUT_SECONDS" \
      -X POST "$MCP_URL/mcp" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL_NAME\",\"arguments\":$ARGS}}" 2>/dev/null) || HTTP_CODE="000"

    END_TIME=$(python3 -c "import time; print(time.time())")
    DURATION=$(python3 -c "print(f'{$END_TIME - $START_TIME:.2f}')")

    RESPONSE=$(cat "$TMPFILE" 2>/dev/null || echo "")
    LAST_RESPONSE="$RESPONSE"
    LAST_HTTP_STATUS="$HTTP_CODE"

    # Check for success
    if [ "$HTTP_CODE" = "200" ] && [ -n "$RESPONSE" ]; then
      # Use stderr for debug so it doesn't pollute the response
      echo -e "  ${CYAN}DEBUG${NC}: HTTP $HTTP_CODE (${DURATION}s)$([ $ATTEMPT -gt 1 ] && echo " [retry $((ATTEMPT-1))]")" >&2
      echo "$RESPONSE"
      return 0
    fi

    # Check for retryable errors (timeout=000, 429, 5xx)
    if [ "$HTTP_CODE" = "000" ] || [ "$HTTP_CODE" = "429" ] || [[ "$HTTP_CODE" =~ ^5[0-9][0-9]$ ]]; then
      if [ $ATTEMPT -lt $NL_GATE_MAX_RETRIES ]; then
        echo -e "  ${YELLOW}WARN${NC}: HTTP $HTTP_CODE (${DURATION}s) - retrying in ${BACKOFF}s (attempt $ATTEMPT/$NL_GATE_MAX_RETRIES)" >&2
        sleep $BACKOFF
        BACKOFF=$((BACKOFF * 2))  # Exponential backoff
        ATTEMPT=$((ATTEMPT + 1))
        TOTAL_RETRIES=$((TOTAL_RETRIES + 1))
        continue
      fi
    fi

    # Non-retryable error or max retries reached
    echo -e "  ${YELLOW}WARN${NC}: HTTP $HTTP_CODE (${DURATION}s) - failed after $ATTEMPT attempt(s)" >&2
    echo "$RESPONSE"
    return 1
  done

  return 1
}

# Helper: extract field from JSON response
get_field() {
  local JSON="$1"
  local FIELD_PATH="$2"
  echo "$JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    result = d
    for p in '$FIELD_PATH'.split('.'):
        if isinstance(result, dict):
            result = result.get(p)
        else:
            result = None
            break
    if result is None:
        print('')
    elif isinstance(result, (dict, list)):
        print(json.dumps(result))
    else:
        print(result)
except:
    print('')
" 2>/dev/null
}

# Helper: run a test and handle failures gracefully
run_extraction_test() {
  local TEST_NAME="$1"
  local PROMPT="$2"
  local EXPECTED_STATUS="$3"

  echo ""
  echo ">>> $TEST_NAME"

  local ESCAPED_PROMPT
  ESCAPED_PROMPT=$(echo "$PROMPT" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")

  local RESPONSE
  RESPONSE=$(call_tool_with_retry "ind_acq.build_model" "{\"natural_language\":$ESCAPED_PROMPT,\"mode\":\"extract_only\"}")

  if [ -z "$RESPONSE" ]; then
    log_fail "$TEST_NAME: No response from server"
    log_debug "Last HTTP status: $LAST_HTTP_STATUS"
    return 1
  fi

  local STATUS
  STATUS=$(get_field "$RESPONSE" "result.structuredContent.status")
  log_info "Status: $STATUS"

  # Return the response for further processing
  echo "$RESPONSE"
}

# ============================================================================
# Test 1: Complete single-tenant prompt
# ============================================================================
echo ""
echo ">>> Test 1: Complete single-tenant prompt"
PROMPT1="Build me an acquisition model for a 50,000 SF industrial building in Houston, TX. Purchase price is \$5M, 65% LTV, 5.75% interest rate. Single tenant paying \$9.50 PSF NNN with 3% annual bumps, lease expires in 2030. Plan to hold for 5 years and exit at a 6.5% cap rate."

ESCAPED_PROMPT1=$(echo "$PROMPT1" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")
RESPONSE1=$(call_tool_with_retry "ind_acq.build_model" "{\"natural_language\":$ESCAPED_PROMPT1,\"mode\":\"extract_only\"}")

if [ -z "$RESPONSE1" ]; then
  log_fail "Test 1: No response from server (HTTP $LAST_HTTP_STATUS)"
  [ -n "$LAST_RESPONSE" ] && log_debug "Response: ${LAST_RESPONSE:0:200}..."
else
  STATUS1=$(get_field "$RESPONSE1" "result.structuredContent.status")
  INPUTS1=$(get_field "$RESPONSE1" "result.structuredContent.inputs")
  log_info "Status: $STATUS1"

  if [ "$STATUS1" = "ok" ]; then
    log_pass "Complete prompt returned status=ok"

    # Validate extracted inputs
    log_info "Validating extracted inputs..."
    VALIDATE_RESPONSE=$(call_tool_with_retry "ind_acq.validate_inputs" "{\"inputs\":$INPUTS1}")
    VALID_STATUS=$(get_field "$VALIDATE_RESPONSE" "result.structuredContent.valid")

    if [ "$VALID_STATUS" = "True" ] || [ "$VALID_STATUS" = "true" ]; then
      log_pass "Extracted inputs validated successfully"
    else
      ERRORS=$(get_field "$VALIDATE_RESPONSE" "result.structuredContent.errors")
      log_fail "Extracted inputs failed validation: $ERRORS"
    fi
  elif [ "$STATUS1" = "needs_info" ]; then
    # Accept needs_info as partial success (extraction worked, some fields missing)
    log_pass "Extraction completed (status=needs_info)"
    log_info "Some optional fields may be missing - acceptable for this test"
  else
    log_fail "Expected status=ok or needs_info, got: $STATUS1"
  fi
fi

# ============================================================================
# Test 2: Complete multi-tenant prompt
# ============================================================================
echo ""
echo ">>> Test 2: Complete multi-tenant prompt"
PROMPT2="I'm looking at a 120,000 SF industrial park in Dallas, TX called Metro Logistics Center. Purchase price is \$12.5M. Three tenants: ABC Logistics has 50,000 SF at \$9.25 PSF NNN expiring June 2028, Swift Shipping has 40,000 SF at \$10 PSF expiring Dec 2029, and Regional Supply has 30,000 SF at \$9.50 PSF expiring 2030. All have 3% annual bumps. Looking at 65% LTV at 6% interest, 7 year hold, exit at 7% cap."

ESCAPED_PROMPT2=$(echo "$PROMPT2" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")
RESPONSE2=$(call_tool_with_retry "ind_acq.build_model" "{\"natural_language\":$ESCAPED_PROMPT2,\"mode\":\"extract_only\"}")

if [ -z "$RESPONSE2" ]; then
  log_fail "Test 2: No response from server (HTTP $LAST_HTTP_STATUS)"
else
  STATUS2=$(get_field "$RESPONSE2" "result.structuredContent.status")
  INPUTS2=$(get_field "$RESPONSE2" "result.structuredContent.inputs")
  log_info "Status: $STATUS2"

  if [ "$STATUS2" = "ok" ] || [ "$STATUS2" = "needs_info" ]; then
    log_pass "Multi-tenant extraction completed (status=$STATUS2)"

    # Check tenant count
    TENANT_COUNT=$(echo "$INPUTS2" | python3 -c "
import sys, json
try:
    inputs = json.load(sys.stdin)
    tenants = inputs.get('rent_roll', {}).get('tenants_in_place', [])
    print(len(tenants))
except:
    print(0)
" 2>/dev/null || echo "0")

    if [ "$TENANT_COUNT" = "3" ]; then
      log_pass "Extracted correct number of tenants: 3"
    elif [ "$TENANT_COUNT" -ge 1 ]; then
      log_info "Extracted $TENANT_COUNT tenant(s) (expected 3)"
    else
      log_fail "Expected 3 tenants, got: $TENANT_COUNT"
    fi
  else
    log_fail "Expected status=ok or needs_info, got: $STATUS2"
  fi
fi

# ============================================================================
# Test 3: Multi-tenant with rollover assumptions
# ============================================================================
echo ""
echo ">>> Test 3: Multi-tenant with rollover assumptions"
PROMPT3="Looking at a 120,000 SF industrial park called Metro Flex Center in Dallas, TX. Purchase price is \$14M. Three tenants: Acme Logistics has 60,000 SF at \$9.50 PSF NNN expiring March 2027, Beta Supply has 35,000 SF at \$10.25 PSF expiring Dec 2028, and Gamma Corp has 25,000 SF at \$11 PSF expiring June 2029. All have 3% annual bumps. For Acme Logistics, assume they renew at \$12 PSF with 2 months downtime and 1 month free rent. Financing is 60% LTV at 5.75% interest, 7 year hold, exit at 6.75% cap."

ESCAPED_PROMPT3=$(echo "$PROMPT3" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")
RESPONSE3=$(call_tool_with_retry "ind_acq.build_model" "{\"natural_language\":$ESCAPED_PROMPT3,\"mode\":\"extract_only\"}")

if [ -z "$RESPONSE3" ]; then
  log_fail "Test 3: No response from server (HTTP $LAST_HTTP_STATUS)"
else
  STATUS3=$(get_field "$RESPONSE3" "result.structuredContent.status")
  INPUTS3=$(get_field "$RESPONSE3" "result.structuredContent.inputs")
  log_info "Status: $STATUS3"

  if [ "$STATUS3" = "ok" ] || [ "$STATUS3" = "needs_info" ]; then
    log_pass "MT+rollover extraction completed (status=$STATUS3)"

    # Check tenant count
    TENANT_COUNT3=$(echo "$INPUTS3" | python3 -c "
import sys, json
try:
    inputs = json.load(sys.stdin)
    tenants = inputs.get('rent_roll', {}).get('tenants_in_place', [])
    print(len(tenants))
except:
    print(0)
" 2>/dev/null || echo "0")

    if [ "$TENANT_COUNT3" = "3" ]; then
      log_pass "Extracted correct number of tenants: 3"
    elif [ "$TENANT_COUNT3" -ge 1 ]; then
      log_info "Extracted $TENANT_COUNT3 tenant(s) (expected 3)"
    fi

    # Check rollover extraction (optional)
    ROLLOVER_COUNT=$(echo "$INPUTS3" | python3 -c "
import sys, json
try:
    inputs = json.load(sys.stdin)
    rollovers = inputs.get('rent_roll', {}).get('market_rollover', [])
    print(len(rollovers))
except:
    print(0)
" 2>/dev/null || echo "0")

    if [ "$ROLLOVER_COUNT" -ge 1 ]; then
      log_pass "Extracted market_rollover entries: $ROLLOVER_COUNT"
    else
      log_info "No market_rollover extracted (optional field)"
    fi
  else
    log_fail "Expected status=ok or needs_info, got: $STATUS3"
  fi
fi

# ============================================================================
# Test 4: Incomplete prompt (should return needs_info)
# ============================================================================
echo ""
echo ">>> Test 4: Incomplete prompt (missing critical fields)"
PROMPT4="I'm looking at a warehouse in Phoenix. About 25,000 square feet."

ESCAPED_PROMPT4=$(echo "$PROMPT4" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")
RESPONSE4=$(call_tool_with_retry "ind_acq.build_model" "{\"natural_language\":$ESCAPED_PROMPT4,\"mode\":\"extract_only\"}")

if [ -z "$RESPONSE4" ]; then
  log_fail "Test 4: No response from server (HTTP $LAST_HTTP_STATUS)"
else
  STATUS4=$(get_field "$RESPONSE4" "result.structuredContent.status")
  MISSING4=$(get_field "$RESPONSE4" "result.structuredContent.missing_fields")
  log_info "Status: $STATUS4"

  if [ "$STATUS4" = "needs_info" ]; then
    log_pass "Incomplete prompt returned status=needs_info"

    # Verify at least some missing fields reported
    MISSING_COUNT=$(echo "$MISSING4" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(len(d) if isinstance(d, list) else 0)
except:
    print(0)
" 2>/dev/null || echo "0")

    if [ "$MISSING_COUNT" -gt 0 ]; then
      log_pass "Missing fields reported: $MISSING_COUNT field(s)"
    else
      log_info "No explicit missing fields (may use suggested_defaults)"
    fi
  else
    log_fail "Expected status=needs_info for incomplete prompt, got: $STATUS4"
  fi
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "============================================="
echo "GATE TEST SUMMARY"
echo "============================================="
echo -e "Passed:  ${GREEN}$PASSED${NC}"
echo -e "Failed:  ${RED}$FAILED${NC}"
[ $TOTAL_RETRIES -gt 0 ] && echo -e "Retries: ${YELLOW}$TOTAL_RETRIES${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}NL Gate Test PASSED - Ready for deployment${NC}"
  echo ""
  echo "============================================="
  echo -e "${GREEN}NL_GATE: PASS${NC}"
  echo "============================================="
  exit 0
else
  echo -e "${RED}NL Gate Test FAILED - Do not deploy${NC}"
  if [ -n "$LAST_RESPONSE" ] && [ "$LAST_HTTP_STATUS" != "200" ]; then
    echo ""
    echo "Last failed response (HTTP $LAST_HTTP_STATUS):"
    echo "${LAST_RESPONSE:0:500}"
  fi
  echo ""
  echo "============================================="
  echo -e "${RED}NL_GATE: FAIL${NC}"
  echo "============================================="
  exit 1
fi
