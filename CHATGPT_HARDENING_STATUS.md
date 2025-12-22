# ChatGPT Hardening Status

Branch: `chatgpt-hardening`
Status: **COMPLETE** - All steps implemented

## Completed

### ✅ STEP 1: Skybridge Bundle (No Iframe)
- Created `web/widget/src/skybridge-entry.tsx` entry point
- Added esbuild configuration (`esbuild.config.mjs`)
- Bundle output: `web/widget/public/skybridge.js` (168.9kb)
- Scripts: `pnpm build:skybridge`, `pnpm build:skybridge:watch`
- MCP widget HTML now loads skybridge.js directly (no iframe)

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

### ✅ STEP 4: Widget Uses window.openai APIs
- `mcp-client.ts` already had `window.openai.callTool` support
- Added `window.openai.setWidgetState()` / `getWidgetState()` for persistence
- Widget state persisted across sessions:
  - Current inputs JSON
  - NL intake text
  - Active view (Inputs/Results)
- `window.openai.openExternal()` used for downloads (already implemented)
- Fallback to direct fetch for localhost dev

### ✅ STEP 5: Minimize structuredContent
- For `status="complete"`: Extract 10 summary metrics for model visibility
- Move full `outputs` map (~150 keys) to `_meta.full_outputs` for widget
- Reduce model-visible payload by ~90%
- structuredContent now includes:
  - `status`, `job_id`
  - `checks.status`, `checks.error_count`
  - `metrics` (10 headline metrics: IRRs, multiples, NOI, proceeds)
  - `download_url`, `download_url_expiry`

### ✅ STEP 6: All Gates Passing
```bash
pnpm run ci
```
- ✓ `pnpm validate:schema` - Default inputs validate
- ✓ `pnpm typecheck` - All packages pass
- ✓ `pnpm build` - All services build including skybridge

## Files Changed

### New Files
- `web/widget/src/skybridge-entry.tsx` - React entry point for skybridge bundle
- `web/widget/esbuild.config.mjs` - esbuild bundler configuration
- `web/widget/public/skybridge.js` - Bundled widget (168.9kb)

### Modified Files
- `web/widget/package.json` - Added esbuild devDependency and build:skybridge script
- `web/widget/src/lib/mcp-client.ts` - Added setWidgetState/getWidgetState exports
- `web/widget/src/app/page.tsx` - State persistence on load/change
- `web/widget/src/components/InputsView.tsx` - nlText prop for controlled state
- `services/mcp-server/src/index.ts` - All server-side hardening
- `package.json` - Added pnpm.onlyBuiltDependencies for esbuild

## Testing

### Local Dev Test
```bash
# Terminal 1: Widget dev server
pnpm --filter @gpc/widget dev

# Terminal 2: MCP Server
export WIDGET_PUBLIC_URL="http://localhost:3001"
pnpm --filter @gpc/mcp-server dev

# Terminal 3: Verify widget HTML
curl http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://widget/ind-acq"}}'
```

### Staging Deployment
1. Deploy widget to Vercel (builds skybridge.js automatically)
2. Deploy MCP server to Render
3. Verify widget loads in ChatGPT connector

## Architecture

```
ChatGPT Apps SDK Runtime
├── Loads widget HTML from MCP resource (text/html+skybridge)
├── Widget HTML includes: <script src="${WIDGET_PUBLIC_URL}/skybridge.js">
├── skybridge.js (168.9kb) contains:
│   ├── React runtime
│   ├── IndAcqWidget component tree
│   ├── Inlined CSS styles
│   └── mcp-client.ts with window.openai support
└── Widget communicates via window.openai.callTool() (no fetch in prod)
```

## Next Steps

1. Merge `chatgpt-hardening` → `main`
2. Deploy to staging (Vercel + Render)
3. Test in ChatGPT connector
4. Submit for OpenAI app review (if applicable)
