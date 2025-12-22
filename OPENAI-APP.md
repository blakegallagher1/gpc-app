# OpenAI ChatGPT App (Apps SDK + MCP) - Project Notes

This document captures the core OpenAI Apps SDK requirements and MCP server architecture
needed to publish a ChatGPT App. It is intentionally concise and scoped to this repo.

Last verified: 2025-12-21

## What a ChatGPT App is
A ChatGPT App has three parts:
1) MCP server: defines tools, enforces auth, returns data, and points tools to UI templates.
2) Widget bundle: renders in ChatGPT's sandboxed iframe and reads data via window.openai.
3) Model behavior: the model chooses when to call tools and narrates from structured data.

A clean separation between server, UI, and model data lets us iterate safely and pass review.

## Minimal architecture flow
User prompt
  -> ChatGPT model decides to call a tool
  -> MCP server executes handler
  -> Tool response includes structuredContent, content, and _meta
  -> ChatGPT renders the widget (text/html+skybridge) with window.openai injected

## MCP server essentials (Apps SDK)
- Register a UI template resource with mimeType: text/html+skybridge.
- Point tools to the template via _meta["openai/outputTemplate"].
- Return three sibling payloads in tool responses:
  - structuredContent: concise JSON the model can see.
  - content: optional narration for the model.
  - _meta: widget-only data (not visible to the model).
- Design tool handlers to be idempotent (the model may retry calls).

## Widget runtime essentials (window.openai)
The widget iframe exposes a single global object:
- Data + state: toolInput, toolOutput, toolResponseMetadata, widgetState
- Actions: callTool, sendFollowUpMessage
- Files: uploadFile, getFileDownloadUrl
- Layout: requestDisplayMode, requestModal, notifyIntrinsicHeight, openExternal
- Context hints: theme, displayMode, maxHeight, safeArea, view, userAgent, locale

Widgets should use window.openai.setWidgetState to persist UI state.

## Build the ChatGPT UI (widget bundle)
UI components render tool results into a widget inside ChatGPT's iframe. Keep the UI
bundle separate from server code and return it as a text/html+skybridge template.

Recommended layout:
app/
  server/            # MCP server
  web/               # UI bundle source
    src/
    dist/

Common setup (Node 18+):
- web/: npm init -y
- web/: npm install react@^18 react-dom@^18
- web/: npm install -D typescript esbuild

Bundle example:
// package.json
{
  "scripts": {
    "build": "esbuild src/component.tsx --bundle --format=esm --outfile=dist/component.js"
  }
}

## window.openai quick reference
State and data:
- toolInput: tool arguments for this invocation.
- toolOutput: structuredContent (model-visible).
- toolResponseMetadata: _meta (widget-only).
- widgetState: persisted UI state.
- setWidgetState(state): sync write; call on every meaningful UI change.

Widget APIs:
- callTool(name, args): invoke a tool from the widget (tool must be widgetAccessible).
- sendFollowUpMessage({ prompt }): ask ChatGPT to post a follow-up message.
- uploadFile(file): uploads image/png, image/jpeg, image/webp, returns fileId.
- getFileDownloadUrl({ fileId }): temporary download URL for a fileId.
- requestDisplayMode({ mode }): inline, pip, fullscreen.
- requestModal(...): host-controlled modal overlay.
- notifyIntrinsicHeight(...): resize hints to avoid clipping.
- openExternal({ href }): open vetted external links.
- requestClose(): close the widget.

## React helper hooks (useOpenAiGlobal / useWidgetState)
Wrap window.openai in hooks to keep components reactive and testable.
Important: widgetState is model-visible and should stay under ~4k tokens.

Structured widget state shape (model-visible + private + images):
type StructuredWidgetState = {
  modelContent: string | Record<string, unknown> | null;
  privateContent: Record<string, unknown> | null;
  imageIds: string[];
};

Only include imageIds for files uploaded via window.openai.uploadFile or file params.

## State management model
Three state types:
- Business data (authoritative): stored on MCP server / backend, returned via tools.
- UI state (ephemeral): per-widget instance via widgetState + setWidgetState.
- Cross-session state (durable): stored in your backend (preferences, filters, etc).

Guidelines:
- Always re-render from the authoritative snapshot returned by tools.
- Keep widgetState focused; it is visible to the model.
- Do not use localStorage for core state.

## Apps SDK UI (optional design system)
Use Apps SDK UI for ready-made components and tokens that match ChatGPT styling.
Install:
- npm install @openai/apps-sdk-ui

Required CSS at top of your global stylesheet:
@import "tailwindcss";
@import "@openai/apps-sdk-ui/css";
@source "../node_modules/@openai/apps-sdk-ui";

Optional provider for router links:
<AppsSDKUIProvider linkComponent={Link}>...</AppsSDKUIProvider>

Dark mode:
- Apply [data-theme] on html or use applyDocumentTheme("dark" | "light").

## Authentication (OAuth 2.1 via MCP authorization spec)
For any user-specific data or write actions, require OAuth 2.1. ChatGPT acts as the
client and uses Authorization Code + PKCE (S256).

Required endpoints and metadata:
- MCP server hosts protected resource metadata:
  `https://your-mcp.example.com/.well-known/oauth-protected-resource`
- Authorization server exposes OAuth or OIDC discovery:
  `https://auth.example.com/.well-known/oauth-authorization-server`
  or `https://auth.example.com/.well-known/openid-configuration`

Redirect URIs to allowlist:
- Production: `https://chatgpt.com/connector_platform_oauth_redirect`
- Review: `https://platform.openai.com/apps-manage/oauth`

Token validation (server-side):
- Verify signature, issuer, audience (resource), expiry, and scopes on every request.
- Reject invalid tokens with 401 + WWW-Authenticate pointing to resource metadata.

Tool-level auth:
- securitySchemes per tool: noauth, oauth2 (with scopes).
- If auth is required and missing/invalid, return _meta["mcp/www_authenticate"]
  with error + error_description to trigger ChatGPT linking UI.

Dynamic client registration (DCR) is required today; plan for high client churn.

## Monetization guidance
Recommended today:
- External checkout on your own domain for physical goods only.

Instant Checkout (private beta, limited):
- Widget calls window.openai.requestCheckout(session).
- Host handles payment UI; tool complete_checkout finalizes the order.
- Implement ACP-compliant session payload and order response.
- Use test payment_mode for end-to-end testing (per PSP guidance).

## UI and App review notes
- Use openai/widgetCSP to allow only required domains (connect/resource/redirect/frame).
- frame_domains triggers stricter review; avoid unless iframes are essential.
- Keep structuredContent tight; oversized payloads degrade model and UI performance.

## Tool design and submission safety
From the App Submission Guidelines (minimum review requirements):
- Purpose and originality: clear user value beyond core ChatGPT capabilities.
- Quality and reliability: stable, low latency, handles errors cleanly.
- Tools are the contract: name, description, and schema must match behavior.
- Correct annotations: readOnlyHint, openWorldHint, destructiveHint where applicable.
- Minimal inputs: only ask for data needed to complete the task.
- Explicit side effects: no hidden writes or external actions.
- Authentication: permissions must be explicit and limited; provide demo creds for review.
- Commerce: only physical goods allowed; digital goods/subscriptions are not allowed.
- External checkout required (no embedded third-party checkout inside the widget).

## App submission and approval requirements
From "Submit your app":
- Verified OpenAI Platform organization and Owner role required.
- MCP server must be publicly accessible (no localhost or test URL).
- CSP must be defined for exact domains used by the widget.
- Use a project with global data residency (EU data residency projects cannot submit).
- Once submitted, tools and metadata are locked; changes require re-submission.

## Render deployment notes (MCP server)
We will deploy the MCP server to Render so it is HTTPS and publicly reachable.
Suggested setup:
- Service type: Web Service (Node or Python)
- Build: install deps and build both server and widget bundle
- Start: run the MCP server and expose /mcp
- Ensure server listens on Render's assigned PORT
- Set environment variables for secrets (never embed in tool outputs or widget state)
- Add a health check path (optional but recommended)

Example (Node) commands, adjust for the repo structure:
- Build command: npm ci && npm run build
- Start command: node dist/server/index.js

## Deploy your app (general)
Deployment options:
- Managed containers: Fly.io, Render, Railway (simple TLS + scaling).
- Serverless containers: Cloud Run / Azure Container Apps (watch cold starts).
- Kubernetes: use ingress that supports streaming (SSE).

Requirements:
- Public HTTPS endpoint.
- /mcp responsive and supports streaming responses.
- Return correct HTTP status codes for errors.

Local development:
- Use ngrok or Cloudflare Tunnel to expose /mcp.
- Rebuild UI bundle and restart server after changes.
- Refresh connector metadata in ChatGPT when tools or descriptions change.

Operational practices:
- Store secrets in env vars (never commit).
- Log tool call IDs, latency, and errors.
- Monitor CPU/memory/requests.

## Connect from ChatGPT (developer mode)
Steps:
1) Enable Settings -> Apps & Connectors -> Advanced -> Developer Mode.
2) Settings -> Connectors -> Create.
3) Provide name, description, and HTTPS /mcp URL.
4) Verify tools list and test in a new chat (use + button -> More).

Refresh metadata after changes:
- Redeploy (or update local tunnel).
- Settings -> Connectors -> Refresh.

Other clients:
- API Playground: Tools -> Add -> MCP Server (good for raw logs).
- Mobile: once linked on web, it appears in mobile clients.

## Testing (before launch)
Focus areas:
- Tool correctness (schemas, errors, edge cases).
- Component UX (rendering, state, layout).
- Discovery precision (metadata triggers).

Recommended:
- Unit test tool handlers and auth flows.
- Use MCP Inspector (npx @modelcontextprotocol/inspector@latest).
- Validate in ChatGPT developer mode with a golden prompt set.
- Test mobile layouts and negative prompts.

## Submit your app (directory)
Prereqs:
- Verified OpenAI org and Owner role.
- MCP server on public HTTPS (no test URLs).
- CSP set to exact domains used by the widget.
- Global data residency project (EU residency projects cannot submit).

Process:
- Submit from OpenAI Platform Dashboard.
- Provide server details and OAuth metadata (if applicable).
- Tools and metadata lock after submission; resubmit for changes.

## Optimize metadata (discovery)
Best practices:
- Use “Use this when...” descriptions and clear tool names.
- Add parameter docs and enums for constrained values.
- Set readOnlyHint/openWorldHint/destructiveHint correctly.
- Build a golden prompt set (direct, indirect, negative) and track outcomes.
- Iterate one change at a time and log results.

## Security & privacy
Core principles:
- Least privilege scopes and inputs.
- Explicit consent for write actions.
- Defense-in-depth (validate every input).

Data handling:
- Do not include secrets in structuredContent or widget state.
- Minimize data collection and response payloads.
- Avoid restricted data (PCI, PHI, SSNs, passwords, MFA codes).
- Avoid requesting precise location in inputs; use coarse system hints if needed.

Widget sandbox:
- No privileged browser APIs (alert/prompt/clipboard).
- CSP-enforced fetch; iframes blocked unless frame_domains set (stricter review).

## Troubleshooting (quick triage)
Server:
- No tools listed: check /mcp endpoint and server logs.
- No component: ensure text/html+skybridge + correct outputTemplate.
- Schema mismatch: verify outputSchema vs actual response.
- Slow responses: profile backend and add caching.

Widget:
- CSP errors: check widgetCSP domains and bundle URLs.
- State not persisting: verify setWidgetState usage and hydration.
- Mobile layout: use displayMode/maxHeight hints.

Discovery:
- Tool never triggers: rewrite metadata and retest with golden prompts.
- Wrong tool: narrow descriptions or split tools.

Auth:
- 401 loops: ensure WWW-Authenticate and correct issuer/audience.
- DCR failures: verify registration_endpoint and PKCE support.

## Reference: tool and resource metadata
Tool descriptor _meta keys:
- securitySchemes (array, for back-compat)
- openai/outputTemplate (UI template URI)
- openai/widgetAccessible (allow widget -> tool calls)
- openai/visibility (public|private)
- openai/toolInvocation/invoking and invoked (<=64 chars)
- openai/fileParams (top-level file inputs)

Tool annotations (required):
- readOnlyHint (true for read-only tools)
- destructiveHint (true for delete/overwrite)
- openWorldHint (true for public or external actions)
- idempotentHint (optional)

Resource _meta keys:
- openai/widgetDescription (model-facing summary)
- openai/widgetPrefersBorder (boolean)
- openai/widgetCSP (connect/resource/frame/redirect domains)
- openai/widgetDomain (optional dedicated origin)

Tool results:
- structuredContent (model-visible, should match outputSchema)
- content (model-visible narration)
- _meta (widget-only data)

Host-provided _meta:
- openai/widgetSessionId (correlate widget instance)

Client-provided hints (do not trust for auth):
- openai/locale, openai/userAgent, openai/userLocation, openai/subject

## Checklist before submission
- [ ] MCP server on public HTTPS domain (Render)
- [ ] /mcp endpoint reachable and tested in Developer Mode
- [ ] Widget template registered as text/html+skybridge
- [ ] openai/widgetCSP includes only required domains
- [ ] Tool schemas, names, and descriptions align with behavior
- [ ] Tool annotations set correctly (readOnlyHint, openWorldHint, destructiveHint)
- [ ] App has clear purpose and is fully functional (no demo-only submission)
- [ ] Auth flow documented; demo credentials ready if required
- [ ] App metadata (name, description, screenshots) ready

## References (official OpenAI docs)
- Build MCP server: `https://developers.openai.com/apps-sdk/build/mcp-server`
- Quickstart: `https://developers.openai.com/apps-sdk/quickstart`
- App submission guidelines: `https://developers.openai.com/apps-sdk/app-submission-guidelines`
- Submit your app: `https://developers.openai.com/apps-sdk/deploy/submission`
- Help Center submission overview: `https://help.openai.com/en/articles/20001040`
