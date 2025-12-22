# ChatGPT Hardening Status

Branch: `chatgpt-hardening`
Commit: `4bbf6ed`

## Completed (Server-Side Only)

### ✅ STEP 2: Widget CSP via MCP Resource Metadata
- Added `buildWidgetCsp()` function to generate CSP domains from config
- Added `openai/widgetCSP` to widget resource `_meta` with:
  - `script_domains`: [widget hostname]
  - `style_domains`: [widget hostname]
  - `connect_domains`: [widget hostname]
  - `redirect_domains`: [B2 download hosts for openExternal]
- B2 hosts derived from `B2_DOWNLOAD_URL` env var + fallback f001-f005 regions

### ✅ STEP 3: Complete Apps SDK Tool Metadata
All 3 tools now have:
- **annotations**: `readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint`
- **securitySchemes**: `[{ type: "noauth" }]` in `_meta`
- **openai/widgetAccessible**: `true`
- **openai/outputTemplate**: `"ui://widget/ind-acq"`
- **openai/toolInvocation**: `invoking` and `invoked` strings

Tool-specific annotations:
- `validate_inputs`: readOnly=true, idempotent=true
- `build_model`: readOnly=false, idempotent=false
- `get_run_status`: readOnly=true, idempotent=true

### ✅ STEP 5: Minimize structuredContent
- For `status="complete"`: Extract 10 summary metrics for model visibility
- Move full `outputs` map (~150 keys) to `_meta.full_outputs` for widget
- Reduce model-visible payload by ~90%
- structuredContent now includes:
  - `status`, `job_id`
  - `checks.status`, `checks.error_count`
  - `metrics` (10 headline metrics: IRRs, multiples, NOI, proceeds)
  - `download_url`, `download_url_expiry`

## Remaining Work

### ⏸️ STEP 1: Remove iframe, serve widget as skybridge HTML bundle
**Status**: Not started (requires significant widget refactoring)

**Requirements**:
1. Create `web/widget/src/skybridge-entry.tsx`:
   - Mount React app to `<div id="root"></div>`
   - Remove Next.js routing dependencies
   - Reuse existing components (InputsView, ResultsView)

2. Add esbuild bundle script:
   - `pnpm build:skybridge` → outputs `web/widget/public/skybridge.js`
   - Bundle React + dependencies into single JS file
   - Optional: Extract CSS to `skybridge.css`

3. Update MCP widget HTML (remove iframe):
   ```html
   <!DOCTYPE html>
   <html>
   <head>
     <meta charset="UTF-8">
     <title>IND_ACQ Widget</title>
   </head>
   <body>
     <div id="root"></div>
     <script src="${WIDGET_PUBLIC_URL}/skybridge.js"></script>
   </body>
   </html>
   ```

4. Update Vercel build to generate skybridge bundle

**Effort**: 2-4 hours
**Risk**: Medium (Next.js → vanilla React migration)

### ⏸️ STEP 4: Widget uses window.openai APIs with state persistence
**Status**: Not started (depends on STEP 1)

**Requirements**:
1. Replace direct `fetch()` with `window.openai.callTool()` in ChatGPT runtime
2. Keep `fetch()` fallback for localhost dev
3. Implement `window.openai.setWidgetState()` for persistence:
   - Current inputs JSON
   - NL intake text + extraction status
   - Active view (Inputs/Results)
   - Last job_id + run status

4. Use `window.openai.openExternal()` for downloads (not `<a href>`)
5. Read `window.openai.toolOutput` / `toolResponseMetadata` when available

**Effort**: 2-3 hours
**Risk**: Low (well-defined window.openai APIs)

### ⏸️ STEP 6: Run all gates
**Status**: Blocked by STEP 1, 4

**Requirements**:
1. `pnpm -r build` (all services)
2. `pnpm validate:schema` (contract validation)
3. `./scripts/regression-test.sh` (requires local services)
4. `./scripts/nl-gate-test.sh` (requires local services + OpenAI API key)
5. `./scripts/golden-pdf-compare.sh` (if applicable locally)
6. Staging deployment test (Render + Vercel)

**Effort**: 1 hour
**Risk**: Low (automated gates)

## Recommendation

### Option A: Complete Widget Refactoring (Full Hardening)
**Timeline**: 4-6 hours additional work
**Deliverables**:
- Skybridge bundle (no iframe)
- window.openai-first widget
- All gates passing

**Pros**:
- Full ChatGPT Apps SDK compliance
- Eliminates review friction
- Future-proof

**Cons**:
- Significant widget refactoring
- Requires testing in ChatGPT runtime

### Option B: Merge Server-Side Changes (Partial Hardening)
**Timeline**: Now
**Deliverables**:
- CSP metadata
- Tool annotations
- Reduced structuredContent

**Pros**:
- Immediate improvement
- Low risk
- No widget changes needed

**Cons**:
- Still uses iframe
- Widget doesn't use window.openai APIs
- May have review friction

### Option C: Document Requirements, Defer Widget Work
**Timeline**: Now
**Deliverables**:
- Server-side changes merged
- Widget requirements documented
- Future task created

**Pros**:
- Unblocks other work
- Clear roadmap for completion

**Cons**:
- Widget work deferred

## Testing Server-Side Changes

### Local Test
```bash
# Terminal 1: Excel Engine
cd services/excel-engine
export DOTNET_ROOT="/opt/homebrew/opt/dotnet@8/libexec"
export PATH="/opt/homebrew/opt/dotnet@8/bin:$PATH"
dotnet run

# Terminal 2: MCP Server
export WIDGET_PUBLIC_URL="https://your-vercel-app.vercel.app"
export B2_DOWNLOAD_URL="https://f005.backblazeb2.com"
pnpm --filter @gpc/mcp-server dev

# Terminal 3: Verify metadata
curl http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}'
```

Expected: Widget resource has `_meta["openai/widgetCSP"]` with domains.

### Staging Test
Deploy to Render + verify CSP headers and tool metadata.

## Next Steps

1. **User Decision**: Choose Option A, B, or C
2. **If Option A**: Proceed with widget refactoring
3. **If Option B or C**: Merge `chatgpt-hardening` → `main`
4. **Run gates**: Verify server-side changes don't break existing functionality
