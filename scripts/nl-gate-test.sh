#!/bin/bash
# NL Extraction Gate Test
# Stricter validation for staging/production gates
# Tests: extraction + validation of complete prompts, missing fields for incomplete

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_URL="${MCP_URL:-http://localhost:8000}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Counters
PASSED=0
FAILED=0

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED+1)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED+1)); }
log_info() { echo -e "  ${CYAN}INFO${NC}: $1"; }

echo "============================================="
echo "NL Extraction Gate Test"
echo "============================================="
echo "MCP_URL: $MCP_URL"
echo ""

# Check if OPENAI_API_KEY is set
if [ -z "$OPENAI_API_KEY" ]; then
  echo -e "${RED}ERROR: OPENAI_API_KEY not set. Gate test requires API key.${NC}"
  exit 1
fi

# Check MCP server health
echo ">>> Checking MCP Server..."
if ! curl -sf "$MCP_URL/health" > /dev/null 2>&1; then
  echo -e "${RED}ERROR: MCP Server not responding at $MCP_URL${NC}"
  exit 1
fi
log_pass "MCP Server is running"

# Helper: call MCP tool
call_tool() {
  local TOOL_NAME="$1"
  local ARGS="$2"
  curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL_NAME\",\"arguments\":$ARGS}}"
}

# Helper: extract field from JSON response
get_field() {
  local JSON="$1"
  local PATH="$2"
  echo "$JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
result = d
for p in '$PATH'.split('.'):
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
" 2>/dev/null
}

# Test 1: Complete single-tenant prompt
echo ""
echo ">>> Test 1: Complete single-tenant prompt"
PROMPT1="Build me an acquisition model for a 50,000 SF industrial building in Houston, TX. Purchase price is \$5M, 65% LTV, 5.75% interest rate. Single tenant paying \$9.50 PSF NNN with 3% annual bumps, lease expires in 2030. Plan to hold for 5 years and exit at a 6.5% cap rate."

RESPONSE1=$(call_tool "ind_acq.build_model" "{\"natural_language\":$(echo "$PROMPT1" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),\"mode\":\"extract_only\"}")
STATUS1=$(get_field "$RESPONSE1" "result.structuredContent.status")
INPUTS1=$(get_field "$RESPONSE1" "result.structuredContent.inputs")
MISSING1=$(get_field "$RESPONSE1" "result.structuredContent.missing_fields")

log_info "Status: $STATUS1"

if [ "$STATUS1" = "ok" ]; then
  log_pass "Complete prompt returned status=ok"

  # Validate extracted inputs
  log_info "Validating extracted inputs..."
  VALIDATE_RESPONSE=$(call_tool "ind_acq.validate_inputs" "{\"inputs\":$INPUTS1}")
  VALID_STATUS=$(get_field "$VALIDATE_RESPONSE" "result.structuredContent.valid")

  if [ "$VALID_STATUS" = "True" ] || [ "$VALID_STATUS" = "true" ]; then
    log_pass "Extracted inputs validated successfully"
  else
    ERRORS=$(get_field "$VALIDATE_RESPONSE" "result.structuredContent.errors")
    log_fail "Extracted inputs failed validation: $ERRORS"
  fi

  # Check no missing fields
  MISSING_COUNT=$(echo "$MISSING1" | python3 -c "import sys,json; d=json.load(sys.stdin) if sys.stdin.read().strip() else []; print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo "0")
  if [ "$MISSING_COUNT" = "0" ] || [ -z "$MISSING1" ] || [ "$MISSING1" = "[]" ]; then
    log_pass "No missing fields for complete prompt"
  else
    log_fail "Unexpected missing fields: $MISSING1"
  fi
else
  log_fail "Expected status=ok for complete prompt, got: $STATUS1"
fi

# Test 2: Complete multi-tenant prompt
echo ""
echo ">>> Test 2: Complete multi-tenant prompt"
PROMPT2="I'm looking at a 120,000 SF industrial park in Dallas, TX called Metro Logistics Center. Purchase price is \$12.5M. Three tenants: ABC Logistics has 50,000 SF at \$9.25 PSF NNN expiring June 2028, Swift Shipping has 40,000 SF at \$10 PSF expiring Dec 2029, and Regional Supply has 30,000 SF at \$9.50 PSF expiring 2030. All have 3% annual bumps. Looking at 65% LTV at 6% interest, 7 year hold, exit at 7% cap."

RESPONSE2=$(call_tool "ind_acq.build_model" "{\"natural_language\":$(echo "$PROMPT2" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),\"mode\":\"extract_only\"}")
STATUS2=$(get_field "$RESPONSE2" "result.structuredContent.status")
INPUTS2=$(get_field "$RESPONSE2" "result.structuredContent.inputs")

log_info "Status: $STATUS2"

if [ "$STATUS2" = "ok" ]; then
  log_pass "Multi-tenant prompt returned status=ok"

  # Validate extracted inputs
  log_info "Validating extracted inputs..."
  VALIDATE_RESPONSE=$(call_tool "ind_acq.validate_inputs" "{\"inputs\":$INPUTS2}")
  VALID_STATUS=$(get_field "$VALIDATE_RESPONSE" "result.structuredContent.valid")

  if [ "$VALID_STATUS" = "True" ] || [ "$VALID_STATUS" = "true" ]; then
    log_pass "Multi-tenant inputs validated successfully"
  else
    ERRORS=$(get_field "$VALIDATE_RESPONSE" "result.structuredContent.errors")
    log_fail "Multi-tenant inputs failed validation: $ERRORS"
  fi

  # Check tenant count
  TENANT_COUNT=$(echo "$INPUTS2" | python3 -c "
import sys, json
inputs = json.load(sys.stdin)
tenants = inputs.get('rent_roll', {}).get('tenants_in_place', [])
print(len(tenants))
" 2>/dev/null || echo "0")

  if [ "$TENANT_COUNT" = "3" ]; then
    log_pass "Extracted correct number of tenants: 3"
  else
    log_fail "Expected 3 tenants, got: $TENANT_COUNT"
  fi
else
  log_fail "Expected status=ok for multi-tenant prompt, got: $STATUS2"
fi

# Test 3: Multi-tenant with rollover
echo ""
echo ">>> Test 3: Multi-tenant with rollover assumptions"
PROMPT3="Looking at a 120,000 SF industrial park called Metro Flex Center in Dallas, TX. Purchase price is \$14M. Three tenants: Acme Logistics has 60,000 SF at \$9.50 PSF NNN expiring March 2027, Beta Supply has 35,000 SF at \$10.25 PSF expiring Dec 2028, and Gamma Corp has 25,000 SF at \$11 PSF expiring June 2029. All have 3% annual bumps. For Acme Logistics, assume they renew at \$12 PSF with 2 months downtime and 1 month free rent. Financing is 60% LTV at 5.75% interest, 7 year hold, exit at 6.75% cap."

RESPONSE3=$(call_tool "ind_acq.build_model" "{\"natural_language\":$(echo "$PROMPT3" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),\"mode\":\"extract_only\"}")
STATUS3=$(get_field "$RESPONSE3" "result.structuredContent.status")
INPUTS3=$(get_field "$RESPONSE3" "result.structuredContent.inputs")

log_info "Status: $STATUS3"

if [ "$STATUS3" = "ok" ]; then
  log_pass "MT+rollover prompt returned status=ok"

  # Validate extracted inputs
  log_info "Validating extracted inputs..."
  VALIDATE_RESPONSE=$(call_tool "ind_acq.validate_inputs" "{\"inputs\":$INPUTS3}")
  VALID_STATUS=$(get_field "$VALIDATE_RESPONSE" "result.structuredContent.valid")

  if [ "$VALID_STATUS" = "True" ] || [ "$VALID_STATUS" = "true" ]; then
    log_pass "MT+rollover inputs validated successfully"
  else
    ERRORS=$(get_field "$VALIDATE_RESPONSE" "result.structuredContent.errors")
    log_fail "MT+rollover inputs failed validation: $ERRORS"
  fi

  # Check tenant count
  TENANT_COUNT3=$(echo "$INPUTS3" | python3 -c "
import sys, json
inputs = json.load(sys.stdin)
tenants = inputs.get('rent_roll', {}).get('tenants_in_place', [])
print(len(tenants))
" 2>/dev/null || echo "0")

  if [ "$TENANT_COUNT3" = "3" ]; then
    log_pass "Extracted correct number of tenants: 3"
  else
    log_fail "Expected 3 tenants, got: $TENANT_COUNT3"
  fi

  # Check rollover extraction
  ROLLOVER_COUNT=$(echo "$INPUTS3" | python3 -c "
import sys, json
inputs = json.load(sys.stdin)
rollovers = inputs.get('rent_roll', {}).get('market_rollover', [])
print(len(rollovers))
" 2>/dev/null || echo "0")

  if [ "$ROLLOVER_COUNT" -ge 1 ]; then
    log_pass "Extracted market_rollover entries: $ROLLOVER_COUNT"
  else
    log_info "No market_rollover extracted (optional field)"
  fi
else
  log_fail "Expected status=ok for MT+rollover prompt, got: $STATUS3"
fi

# Test 4: Incomplete prompt (should return needs_info)
echo ""
echo ">>> Test 4: Incomplete prompt (missing critical fields)"
PROMPT4="I'm looking at a warehouse in Phoenix. About 25,000 square feet."

RESPONSE4=$(call_tool "ind_acq.build_model" "{\"natural_language\":$(echo "$PROMPT4" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),\"mode\":\"extract_only\"}")
STATUS4=$(get_field "$RESPONSE4" "result.structuredContent.status")
MISSING4=$(get_field "$RESPONSE4" "result.structuredContent.missing_fields")

log_info "Status: $STATUS4"

if [ "$STATUS4" = "needs_info" ]; then
  log_pass "Incomplete prompt returned status=needs_info"

  # Check that critical fields are in missing_fields
  CRITICAL_FIELDS=("acquisition.purchase_price" "rent_roll.tenants_in_place" "exit.exit_cap_rate")

  for FIELD in "${CRITICAL_FIELDS[@]}"; do
    FOUND=$(echo "$MISSING4" | python3 -c "
import sys, json
missing = json.load(sys.stdin) if sys.stdin.read().strip() else []
for m in missing:
    if m.get('path') == '$FIELD' or m.get('field') == '$FIELD':
        print('1')
        break
else:
    print('0')
" 2>/dev/null || echo "0")

    if [ "$FOUND" = "1" ]; then
      log_pass "Critical field '$FIELD' reported as missing"
    else
      log_info "Field '$FIELD' not explicitly listed (may be grouped)"
    fi
  done

  # Verify at least some missing fields reported
  MISSING_COUNT=$(echo "$MISSING4" | python3 -c "import sys,json; d=json.load(sys.stdin) if sys.stdin.read().strip() else []; print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo "0")
  if [ "$MISSING_COUNT" -gt 0 ]; then
    log_pass "Missing fields reported: $MISSING_COUNT field(s)"
  else
    log_fail "No missing fields reported for incomplete prompt"
  fi
else
  log_fail "Expected status=needs_info for incomplete prompt, got: $STATUS4"
fi

# Summary
echo ""
echo "============================================="
echo "GATE TEST SUMMARY"
echo "============================================="
echo -e "Passed:  ${GREEN}$PASSED${NC}"
echo -e "Failed:  ${RED}$FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}NL Gate Test PASSED - Ready for deployment${NC}"
  exit 0
else
  echo -e "${RED}NL Gate Test FAILED - Do not deploy${NC}"
  exit 1
fi
