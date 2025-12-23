import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import OpenAI from "openai";

// Handle ESM default export - use any to bypass type checking for these modules
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020Module as any).default ?? Ajv2020Module;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
import { EXCEL_ENGINE_BASE_URL, contractsPath } from "./config.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8000);
const WIDGET_PUBLIC_URL = process.env.WIDGET_PUBLIC_URL ?? process.env.WIDGET_URL ?? "http://localhost:3001";
// MCP server public URL for CSP connect-src (defaults to localhost for dev)
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`;
// B2 download URL for CSP allow-list (defaults to common Backblaze endpoints)
const B2_DOWNLOAD_URL = process.env.B2_DOWNLOAD_URL?.trim() ?? "";
const DEAL_ENGINE_VALIDATE = process.env.DEAL_ENGINE_VALIDATE === "true";
const MCP_PATH = "/mcp";

// Cache build inputs for optional Deal Engine validation (keyed by job_id)
const indAcqInputsByJobId = new Map<string, Record<string, unknown>>();
const dealEngineValidationByJobId = new Map<string, ValidationComparison>();

// Instrumentation logger - redacts sensitive info
const log = {
  info: (msg: string, meta?: Record<string, unknown>) => {
    const safeMeta = meta ? redactSensitive(meta) : undefined;
    console.log(`[INFO] ${msg}`, safeMeta ? JSON.stringify(safeMeta) : "");
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    const safeMeta = meta ? redactSensitive(meta) : undefined;
    console.warn(`[WARN] ${msg}`, safeMeta ? JSON.stringify(safeMeta) : "");
  },
  error: (msg: string, meta?: Record<string, unknown>) => {
    const safeMeta = meta ? redactSensitive(meta) : undefined;
    console.error(`[ERROR] ${msg}`, safeMeta ? JSON.stringify(safeMeta) : "");
  },
};

// Redact sensitive values from logs
function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    // Redact auth tokens, API keys, credentials
    if (lowerKey.includes("authorization") || lowerKey.includes("token") ||
        lowerKey.includes("key") || lowerKey.includes("secret") ||
        lowerKey.includes("password") || lowerKey.includes("credential")) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.includes("Authorization=")) {
      // Redact B2 auth tokens in URLs
      result[key] = value.replace(/Authorization=[^&]+/, "Authorization=[REDACTED]");
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// Log legacy env var usage
if (process.env.WIDGET_URL && !process.env.WIDGET_PUBLIC_URL) {
  console.warn("[WARN] Using legacy WIDGET_URL. Please migrate to WIDGET_PUBLIC_URL");
}

// Tool input schemas (Zod for runtime validation)
const validateInputsInputSchema = z.object({
  inputs: z.record(z.unknown()),
});

// Use a permissive schema - MCP SDK's Zod conversion drops optional fields
// We validate manually in the handler
const buildModelInputSchema = z.object({}).passthrough();

const getRunStatusInputSchema = z.object({
  job_id: z.string().min(1),
});

// JSON Schemas for OpenAI tool metadata (exactly 3 tools)
const toolInputJsonSchemas = {
  validate_inputs: {
    type: "object",
    additionalProperties: false,
    required: ["inputs"],
    properties: {
      inputs: { type: "object" },
    },
  },
  build_model: {
    type: "object",
    additionalProperties: false,
    properties: {
      inputs: { type: "object", description: "Structured underwriting inputs" },
      natural_language: { type: "string", description: "Natural language deal description for AI extraction" },
      mode: {
        type: "string",
        enum: ["extract_only", "run"],
        description: "extract_only: return extracted inputs without running. run: validate and build model (default)"
      },
    },
  },
  get_run_status: {
    type: "object",
    additionalProperties: false,
    required: ["job_id"],
    properties: {
      job_id: { type: "string", minLength: 1 },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Initialize OpenAI client (uses OPENAI_API_KEY env var by default)
const openai = new OpenAI();
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.1";

const inputSchema = await loadJson(contractsPath.inputSchema);
const outputMapping = await loadJson(contractsPath.outputMapping);
const validateInputsContract = ajv.compile(inputSchema);

// Critical fields that must be provided (never invented by AI)
const CRITICAL_FIELDS = [
  "acquisition.purchase_price",
  "rent_roll.tenants_in_place",
  "exit.exit_cap_rate",
  "debt.acquisition_loan.ltv_max",
  "debt.acquisition_loan.rate.fixed_rate",
];

// Non-critical fields with sensible defaults
const DEFAULT_VALUES: Record<string, unknown> = {
  "contract.contract_version": "IND_ACQ_V1",
  "contract.template_id": "IND_ACQ",
  "contract.currency": "USD",
  "operating.vacancy_pct": 0.05,
  "operating.credit_loss_pct": 0.02,
  "operating.inflation.rent": 0.03,
  "operating.inflation.expenses": 0.025,
  "operating.inflation.taxes": 0.02,
  "operating.expenses.management_fee_pct_egi": 0.04,
  "operating.expenses.recoveries.mode": "NNN",
  "acquisition.closing_cost_pct": 0.015,
  "debt.acquisition_loan.enabled": true,
  "debt.acquisition_loan.amort_years": 25,
  "debt.acquisition_loan.io_months": 12,
  "debt.acquisition_loan.origination_fee_pct": 0.01,
  "debt.acquisition_loan.rate.type": "FIXED",
  "exit.sale_cost_pct": 0.02,
  "exit.forward_noi_months": 12,
};

// Build CSP directives for Apps SDK widget (legacy HTML meta tag)
// Note: ChatGPT Apps submission requires _meta CSP, not just HTML meta tags
function buildCsp(): string {
  const widgetOrigin = new URL(WIDGET_PUBLIC_URL).origin;
  const mcpOrigin = new URL(MCP_PUBLIC_URL).origin;

  // Build connect-src list with B2 download URLs
  const connectSrc = [mcpOrigin, EXCEL_ENGINE_BASE_URL];

  // Add Backblaze B2 download URLs to CSP
  // Default B2 regions for file downloads (f001-f005.backblazeb2.com)
  const b2Hosts = [
    "https://f005.backblazeb2.com",
    "https://f004.backblazeb2.com",
    "https://f003.backblazeb2.com",
    "https://f002.backblazeb2.com",
    "https://f001.backblazeb2.com",
  ];

  // Add custom B2 download URL if specified
  if (B2_DOWNLOAD_URL) {
    try {
      const customOrigin = new URL(B2_DOWNLOAD_URL).origin;
      if (!b2Hosts.includes(customOrigin)) {
        b2Hosts.unshift(customOrigin);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  connectSrc.push(...b2Hosts);

  return [
    `default-src 'none'`,
    `script-src 'self' ${widgetOrigin} 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline'`,
    `connect-src ${connectSrc.join(' ')}`,
    `img-src 'self' data:`,
  ].join('; ');
}

// Build Apps SDK widgetCSP object for MCP resource metadata
function buildWidgetCsp(): Record<string, unknown> {
  const widgetOrigin = new URL(WIDGET_PUBLIC_URL).origin;
  const mcpOrigin = new URL(MCP_PUBLIC_URL).origin;

  // B2 redirect domains (full origins for file downloads)
  const b2RedirectDomains = [
    "https://f001.backblazeb2.com",
    "https://f002.backblazeb2.com",
    "https://f003.backblazeb2.com",
    "https://f004.backblazeb2.com",
    "https://f005.backblazeb2.com",
  ];

  // Add custom B2 download URL if specified
  if (B2_DOWNLOAD_URL) {
    try {
      const customB2Origin = new URL(B2_DOWNLOAD_URL).origin;
      if (!b2RedirectDomains.includes(customB2Origin)) {
        b2RedirectDomains.unshift(customB2Origin);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return {
    // resource_domains: where widget assets (JS/CSS) are loaded from
    resource_domains: [widgetOrigin],
    // connect_domains: where widget can make API calls (MCP server)
    connect_domains: [mcpOrigin],
    // redirect_domains: where download links redirect (B2 file storage)
    redirect_domains: b2RedirectDomains,
  };
}

// Get widget origin for widgetDomain metadata
function getWidgetOrigin(): string {
  return new URL(WIDGET_PUBLIC_URL).origin;
}

// Widget HTML template for ChatGPT Apps SDK (skybridge bundle - no iframe)
function getWidgetHtml(): string {
  const csp = buildCsp();
  // Load skybridge.js directly - bundled React app without Next.js runtime
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>IND_ACQ Widget</title>
</head>
<body>
  <div id="root"></div>
  <script src="${WIDGET_PUBLIC_URL}/skybridge.js"></script>
</body>
</html>`;
}

interface DealEngineInputsV0 {
  contract: { contract_version: "DEAL_ENGINE_V0"; engine_version: string };
  deal: {
    project_name: string;
    city: string;
    state: string;
    analysis_start_date: string;
    hold_period_months: number;
    gross_sf: number;
    net_sf: number;
  };
  modules: {
    acquisition: {
      purchase_price: number;
      closing_cost_pct: number;
      close_month?: number;
      option_fee?: number;
      reserves_at_closing?: number;
    };
    lease: { tenants_in_place: unknown[]; market_rollover?: unknown[] };
    operating?: {
      vacancy_pct: number;
      credit_loss_pct: number;
      inflation: { rent: number; expenses: number; taxes: number; recoveries?: number };
      expenses: {
        recoveries: { mode: string };
        fixed_annual?: { reserves?: number; reserves_growth_pct?: number };
      };
    };
    debt?: { acquisition_loan: { ltv_max: number; rate: number; amort_years: number; io_months: number; term_months: number } };
    exit: { exit_cap_rate: number; exit_month: number; sale_cost_pct: number; forward_noi_months?: number };
    returns?: { discount_rate_unlevered?: number; discount_rate_levered?: number };
  };
}

function transformToDealEngineV0(indAcq: Record<string, unknown>): DealEngineInputsV0 {
  const deal = indAcq.deal as Record<string, unknown>;
  const acq = indAcq.acquisition as Record<string, unknown>;
  const rentRoll = indAcq.rent_roll as Record<string, unknown>;
  const op = indAcq.operating as Record<string, unknown>;
  const debt = indAcq.debt as Record<string, unknown>;
  const exit = indAcq.exit as Record<string, unknown>;
  const returns = indAcq.returns as Record<string, unknown>;
  const debtLoan = (debt?.acquisition_loan as Record<string, unknown>) ?? {};
  const debtRate = (debtLoan.rate as Record<string, unknown>) ?? {};

  return {
    contract: { contract_version: "DEAL_ENGINE_V0", engine_version: "0.1.0" },
    deal: {
      project_name: (deal?.project_name as string) ?? "Unnamed",
      city: (deal?.city as string) ?? "",
      state: (deal?.state as string) ?? "",
      analysis_start_date: (deal?.analysis_start_date as string) ?? "",
      hold_period_months: (deal?.hold_period_months as number) ?? 60,
      gross_sf: (deal?.gross_sf as number) ?? 0,
      net_sf: (deal?.net_sf as number) ?? 0,
    },
    modules: {
      acquisition: {
        purchase_price: (acq?.purchase_price as number) ?? 0,
        closing_cost_pct: (acq?.closing_cost_pct as number) ?? 0.015,
        close_month: (acq?.close_month as number) ?? 0,
        option_fee: (acq?.option_fee as number) ?? 0,
        reserves_at_closing: (acq?.reserves_at_closing as number) ?? 0,
      },
      lease: {
        tenants_in_place: (rentRoll?.tenants_in_place as unknown[]) ?? [],
        market_rollover: rentRoll?.market_rollover as unknown[] | undefined,
      },
      operating: op
        ? {
            vacancy_pct: (op.vacancy_pct as number) ?? 0.05,
            credit_loss_pct: (op.credit_loss_pct as number) ?? 0.02,
            inflation:
              (op.inflation as { rent: number; expenses: number; taxes: number; recoveries?: number }) ??
              { rent: 0.03, expenses: 0.025, taxes: 0.02, recoveries: 0.02 },
            expenses: {
              recoveries: { mode: (((op.expenses as Record<string, unknown>)?.recoveries as Record<string, unknown>)?.mode as string) ?? "NNN" },
              fixed_annual: (op.expenses as Record<string, unknown>)?.fixed_annual as
                | { reserves?: number; reserves_growth_pct?: number }
                | undefined,
            },
          }
        : undefined,
      debt: debtLoan.ltv_max
        ? {
            acquisition_loan: {
              ltv_max: debtLoan.ltv_max as number,
              rate: (debtRate.fixed_rate as number) ?? 0.065,
              amort_years: (debtLoan.amort_years as number) ?? 25,
              io_months: (debtLoan.io_months as number) ?? 12,
              term_months: (debtLoan.term_months as number) ?? 60,
            },
          }
        : undefined,
      exit: {
        exit_cap_rate: (exit?.exit_cap_rate as number) ?? 0.07,
        exit_month: (exit?.exit_month as number) ?? 60,
        sale_cost_pct: (exit?.sale_cost_pct as number) ?? 0.02,
        forward_noi_months: exit?.forward_noi_months as number | undefined,
      },
      returns: returns
        ? {
            discount_rate_unlevered: (returns?.discount_rate_unlevered as number) ?? undefined,
            discount_rate_levered: (returns?.discount_rate_levered as number) ?? undefined,
          }
        : undefined,
    },
  };
}

interface ValidationComparison {
  enabled: boolean;
  dealEngineSuccess?: boolean;
  discrepancies?: { metric: string; excel: number; dealEngine: number; pctDiff: number }[];
  error?: string;
}

async function runDealEngineValidation(
  inputs: Record<string, unknown>,
  excelOutputs: Record<string, unknown>
): Promise<ValidationComparison> {
  if (!DEAL_ENGINE_VALIDATE) return { enabled: false };

  try {
    // @ts-expect-error - @gpc/deal-engine is optional; dynamically imported only when DEAL_ENGINE_VALIDATE=true
    const { DealEngine } = await import("@gpc/deal-engine");
    const engine = new DealEngine();
    const transformed = transformToDealEngineV0(inputs);
    const result = await engine.run(transformed);

    if (!result.success || !result.context) {
      return { enabled: true, dealEngineSuccess: false, error: result.errors?.join("; ") };
    }

    const m = result.context.metrics;
    const discrepancies: { metric: string; excel: number; dealEngine: number; pctDiff: number }[] = [];

    const comparisons = [
      { metric: "unlevered_irr", excel: excelOutputs["out.returns.unlevered.irr"] as number, de: m.unleveredIrr },
      { metric: "levered_irr", excel: excelOutputs["out.returns.levered.irr"] as number, de: m.leveredIrr },
      { metric: "year1_noi", excel: excelOutputs["out.cashflow.year_1_noi"] as number, de: m.noiYear1 },
    ];

    for (const c of comparisons) {
      if (c.excel != null && c.de != null) {
        const pctDiff = Math.abs((c.excel - c.de) / (c.excel || 1)) * 100;
        if (pctDiff > 1) {
          discrepancies.push({ metric: c.metric, excel: c.excel, dealEngine: c.de, pctDiff });
          log.warn("Deal Engine validation discrepancy", {
            metric: c.metric,
            excel: c.excel,
            dealEngine: c.de,
            pctDiff: pctDiff.toFixed(2) + "%",
          });
        }
      }
    }

    return { enabled: true, dealEngineSuccess: true, discrepancies: discrepancies.length > 0 ? discrepancies : undefined };
  } catch (e) {
    log.warn("Deal Engine validation failed", { error: String(e) });
    return { enabled: true, dealEngineSuccess: false, error: String(e) };
  }
}

function createIndAcqServer() {
  const server = new McpServer({ name: "ind-acq-mcp", version: "0.1.0" });

  // Register widget resource for ChatGPT Apps SDK
  // All _meta fields required for ChatGPT Apps submission
  server.resource(
    "ind-acq-widget",
    "ui://widget/ind-acq",
    {
      description: "IND_ACQ Underwriting Widget UI",
      mimeType: "text/html+skybridge",
      _meta: {
        "openai/widgetCSP": buildWidgetCsp(),
        "openai/widgetDomain": getWidgetOrigin(),
        "openai/widgetDescription": "Industrial acquisition underwriting widget (IND_ACQ).",
        "openai/widgetPrefersBorder": true,
      },
    },
    async () => ({
      contents: [
        {
          uri: "ui://widget/ind-acq",
          mimeType: "text/html+skybridge",
          text: getWidgetHtml(),
          _meta: {
            "openai/widgetCSP": buildWidgetCsp(),
            "openai/widgetDomain": getWidgetOrigin(),
            "openai/widgetDescription": "Industrial acquisition underwriting widget (IND_ACQ).",
            "openai/widgetPrefersBorder": true,
          },
        },
      ],
    })
  );

  // Tool 1: validate_inputs (widget-only, hidden from model selection)
  server.registerTool(
    "ind_acq.validate_inputs",
    {
      title: "Validate Model Inputs (Widget Internal)",
      description: "Internal validation endpoint for the widget UI. Not for direct model use - use build_model instead for all deal requests.",
      inputSchema: validateInputsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        json_schema: toolInputJsonSchemas.validate_inputs,
        securitySchemes: [{ type: "noauth" }],
        "openai/visibility": "private",
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Validating underwriting inputs...",
        "openai/toolInvocation/invoked": "Input validation complete",
      },
    },
    async (args) => {
      const result = validateInputs(args.inputs);
      return buildToolResponse(result);
    }
  );

  // Tool 2: build_model (NL-first with structured fallback)
  server.registerTool(
    "ind_acq.build_model",
    {
      title: "Build Industrial Acquisition Model",
      description: "Build a commercial real estate acquisition model. Use this when a user describes a deal - provide their description in the 'natural_language' parameter and the system will extract inputs and build the model. Accepts natural language deal descriptions OR structured inputs. For natural language, provide only 'natural_language' (no 'inputs' needed).",
      inputSchema: buildModelInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: {
        json_schema: toolInputJsonSchemas.build_model,
        securitySchemes: [{ type: "noauth" }],
        "openai/outputTemplate": "ui://widget/ind-acq",
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Building underwriting model...",
        "openai/toolInvocation/invoked": "Model build started",
      },
    },
    async (args) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let mergedInputs = (args.inputs ?? {}) as Record<string, unknown>;
      let extractionMeta: ExtractionMeta | undefined;

      // Check if this is an NL-only call (natural_language present, inputs missing/empty)
      const hasNL = args.natural_language && typeof args.natural_language === "string" && args.natural_language.trim();
      const hasInputs = args.inputs && Object.keys(args.inputs).length > 0;

      // Default to extract_only for NL-only calls (no inputs), run otherwise
      // This prevents accidental runs without all required inputs
      const mode = args.mode ?? (hasNL && !hasInputs ? "extract_only" : "run");

      log.info("build_model called", { requestId, mode, hasNL: !!hasNL, hasInputs: !!hasInputs });

      // If natural_language is provided, extract inputs first
      if (args.natural_language && typeof args.natural_language === "string" && args.natural_language.trim()) {
        try {
          const extractionStart = Date.now();
          const extraction = await extractInputsFromNL(args.natural_language.trim());
          const extractionDurationMs = Date.now() - extractionStart;

          log.info("NL extraction complete", {
            requestId,
            extractionDurationMs,
            status: extraction.status,
            missingFieldCount: extraction.missing_fields?.length ?? 0,
            tokenUsage: extraction.tokenUsage,
          });

          if (extraction.status === "error") {
            return buildToolResponse({
              status: "failed",
              error: extraction.error ?? "Extraction failed",
            });
          }

          // Merge extracted inputs with provided inputs (user inputs win)
          mergedInputs = deepMerge(extraction.inputs ?? {}, mergedInputs);
          extractionMeta = {
            missing_fields: extraction.missing_fields ?? [],
            suggested_defaults: extraction.suggested_defaults ?? {},
          };

          // If critical fields are missing, return needs_info
          // Only block on truly critical missing fields (exact match, not sub-fields)
          if (extraction.missing_fields && extraction.missing_fields.length > 0) {
            const criticalMissing = extraction.missing_fields.filter((f) => {
              // Exact match check - don't match sub-fields of arrays
              // e.g., "rent_roll.tenants_in_place" is critical, but
              // "rent_roll.tenants_in_place[0].lease_start" is not
              return CRITICAL_FIELDS.some((cf) => {
                if (f.path === cf) return true;
                // For non-array critical fields, check if it's an exact path match
                // Don't match array element sub-fields like [0].lease_start
                if (f.path.startsWith(cf) && !f.path.includes("[")) return true;
                return false;
              });
            });

            if (criticalMissing.length > 0) {
              return buildToolResponse({
                status: "needs_info",
                inputs: mergedInputs,
                missing_fields: criticalMissing,
                suggested_defaults: extraction.suggested_defaults ?? {},
              });
            }
          }
        } catch (error) {
          return buildToolResponse({
            status: "failed",
            error: `NL extraction failed: ${String(error)}`,
          });
        }
      }

      // Ensure rollover coverage for leases expiring before exit
      const rolloverResult = ensureRolloverCoverage(mergedInputs);
      mergedInputs = rolloverResult.inputs;
      const rolloverWarnings = rolloverResult.warnings;

      if (rolloverWarnings.length > 0) {
        log.info("Auto-generated rollover entries", { requestId, warnings: rolloverWarnings });
      }

      // If mode is extract_only, return the merged inputs without running
      if (mode === "extract_only") {
        // Validate to find any remaining missing fields
        const validation = validateInputs(mergedInputs);

        if (validation.status === "invalid") {
          // Convert validation errors to missing fields for extract_only mode
          const missingFromValidation = validation.errors
            .filter((e) => e.message?.includes("required"))
            .map((e) => ({
              path: e.path,
              description: e.message,
            }));

          return buildToolResponse({
            status: "needs_info",
            inputs: mergedInputs,
            missing_fields: [...(extractionMeta?.missing_fields ?? []), ...missingFromValidation],
            suggested_defaults: extractionMeta?.suggested_defaults ?? {},
          });
        }

        return buildToolResponse({
          status: "ok",
          inputs: mergedInputs,
          missing_fields: extractionMeta?.missing_fields ?? [],
          suggested_defaults: extractionMeta?.suggested_defaults ?? {},
          ...(rolloverWarnings.length > 0 ? { rollover_notes: rolloverWarnings } : {}),
        });
      }

      // mode === "run" - validate and build
      const validation = validateInputs(mergedInputs);
      if (validation.status === "invalid") {
        return buildToolResponse(validation);
      }

      let response: Response;
      try {
        response = await fetch(`${EXCEL_ENGINE_BASE_URL}/v1/ind-acq/build`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inputs: mergedInputs, mapping: outputMapping.mapping }),
        });
      } catch (error) {
        return buildToolResponse({
          status: "failed",
          error: `Unable to reach Excel engine at ${EXCEL_ENGINE_BASE_URL}: ${String(error)}`,
        });
      }

      if (!response.ok) {
        const body = await safeReadBody(response);
        return buildToolResponse({
          status: "failed",
          error: `Excel engine error (${response.status}): ${body}`,
        });
      }

      const payload = await response.json();
      if (!payload?.job_id) {
        log.error("Excel engine missing job_id", { requestId });
        return buildToolResponse({
          status: "failed",
          error: "Excel engine did not return job_id.",
        });
      }

      log.info("Model build started", { requestId, job_id: payload.job_id });

      if (DEAL_ENGINE_VALIDATE) {
        indAcqInputsByJobId.set(payload.job_id, mergedInputs);
        dealEngineValidationByJobId.delete(payload.job_id);
      }

      return buildToolResponse({
        status: "started",
        job_id: payload.job_id,
        ...(rolloverWarnings.length > 0 ? { rollover_notes: rolloverWarnings } : {}),
      });
    }
  );

  // Tool 3: get_run_status
  server.registerTool(
    "ind_acq.get_run_status",
    {
      title: "Get IND_ACQ run status",
      description: "Retrieves status for a build job.",
      inputSchema: getRunStatusInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        json_schema: toolInputJsonSchemas.get_run_status,
        securitySchemes: [{ type: "noauth" }],
        "openai/outputTemplate": "ui://widget/ind-acq",
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Checking job status...",
        "openai/toolInvocation/invoked": "Status retrieved",
      },
    },
    async (args) => {
      const jobId = args.job_id?.trim();
      if (!jobId) {
        return buildToolResponse({
          status: "failed",
          error: "job_id is required.",
        });
      }

      let response: Response;
      try {
        response = await fetch(`${EXCEL_ENGINE_BASE_URL}/v1/jobs/${jobId}`);
      } catch (error) {
        log.error("Failed to reach Excel engine", { job_id: jobId, error: String(error) });
        return buildToolResponse({
          status: "failed",
          job_id: jobId,
          error: `Unable to reach Excel engine at ${EXCEL_ENGINE_BASE_URL}: ${String(error)}`,
        });
      }
      if (!response.ok) {
        const body = await safeReadBody(response);
        log.error("Excel engine error", { job_id: jobId, status: response.status });
        return buildToolResponse({
          status: "failed",
          job_id: jobId,
          error: `Excel engine error (${response.status}): ${body}`,
        });
      }

      const payload = await response.json();
      const status = payload?.status;

      log.info("Job status retrieved", { job_id: jobId, status });

      if (status === "pending" || status === "running") {
        return buildToolResponse({ status, job_id: jobId });
      }

      if (status === "complete") {
        const outputs = (payload.outputs ?? {}) as Record<string, unknown>;

        // Log completion with redacted download_url
        log.info("Job complete", {
          job_id: jobId,
          download_url: payload.download_url ? "[URL_PRESENT]" : null,
          warning: payload.warning ?? null,
        });

        let dealEngineValidation: ValidationComparison = { enabled: false };
        if (DEAL_ENGINE_VALIDATE) {
          dealEngineValidation = dealEngineValidationByJobId.get(jobId) ?? { enabled: true, dealEngineSuccess: false, error: "Validation not run." };

          if (!dealEngineValidationByJobId.has(jobId)) {
            const cachedInputs = indAcqInputsByJobId.get(jobId);
            if (cachedInputs) {
              dealEngineValidation = await runDealEngineValidation(cachedInputs, outputs);
              indAcqInputsByJobId.delete(jobId);
              dealEngineValidationByJobId.set(jobId, dealEngineValidation);
            } else {
              dealEngineValidation = {
                enabled: true,
                dealEngineSuccess: false,
                error: "Validation enabled but inputs were not cached for this job_id (likely server restart).",
              };
              dealEngineValidationByJobId.set(jobId, dealEngineValidation);
            }
          }
        }

        return buildToolResponse({
          status,
          job_id: jobId,
          outputs,
          file_path: payload.file_path ?? null,
          download_url: payload.download_url ?? null,
          download_url_expiry: payload.download_url_expiry ?? null,
          warning: payload.warning ?? null,
          deal_engine_validation: dealEngineValidation,
        });
      }

      if (status === "failed") {
        indAcqInputsByJobId.delete(jobId);
        dealEngineValidationByJobId.delete(jobId);
        log.error("Job failed", { job_id: jobId, error: payload.error });
        return buildToolResponse({
          status,
          job_id: jobId,
          error: payload.error ?? "Job failed.",
        });
      }

      return buildToolResponse({
        status: "failed",
        job_id: jobId,
        error: `Unknown job status: ${status ?? "missing"}`,
      });
    }
  );

  return server;
}

// Validation (no partial mode exposed to clients)
function validateInputs(inputs: unknown): ValidationResult {
  if (!validateInputsContract(inputs)) {
    const errors = (validateInputsContract.errors ?? []).map((error: { instancePath?: string; message?: string }) => ({
      path: error.instancePath || "/",
      message: error.message ?? "Invalid value.",
    }));
    return { status: "invalid", errors };
  }
  return { status: "ok" };
}

function buildToolResponse(result: ToolResult) {
  const jobId = "job_id" in result ? result.job_id : undefined;

  // Minimize structuredContent - move large payloads to metadata
  let structuredContent: Record<string, unknown>;
  let metadata: Record<string, unknown> | undefined;

  if (result.status === "complete" && "outputs" in result) {
    // Extract summary metrics for model visibility
    const summaryMetrics = extractSummaryMetrics(result.outputs);

    structuredContent = {
      status: result.status,
      job_id: result.job_id,
      checks: {
        status: result.outputs["out.checks.status"],
        error_count: result.outputs["out.checks.error_count"],
      },
      metrics: summaryMetrics,
      download_url: result.download_url,
      download_url_expiry: result.download_url_expiry,
      // Include warning if MT template was quarantined
      ...(result.warning ? { warning: result.warning } : {}),
    };

    // Full outputs in metadata for widget consumption
    metadata = {
      job_id: jobId,
      full_outputs: result.outputs,
      file_path: result.file_path,
    };
  } else {
    // For non-complete statuses, keep structuredContent as-is
    structuredContent = result as Record<string, unknown>;
    metadata = jobId ? { job_id: jobId } : undefined;
  }

  return {
    content: resultToContent(result),
    structuredContent,
    _meta: metadata,
  };
}

// Extract summary metrics for model visibility (small footprint)
function extractSummaryMetrics(outputs: Record<string, unknown>): Record<string, unknown> {
  const summaryKeys = [
    "out.returns.unlevered.irr",
    "out.returns.levered.irr",
    "out.returns.investor.irr",
    "out.returns.unlevered.multiple",
    "out.returns.levered.multiple",
    "out.returns.investor.multiple",
    "out.debt.total_proceeds",
    "out.cashflow.year_1_noi",
    "out.cashflow.stabilized_noi",
    "out.exit.sale_proceeds",
  ];

  const summary: Record<string, unknown> = {};
  for (const key of summaryKeys) {
    if (key in outputs) {
      summary[key] = outputs[key];
    }
  }
  return summary;
}

function resultToContent(result: ToolResult) {
  const text = JSON.stringify(result);
  return [{ type: "text" as const, text }];
}

async function loadJson(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function safeReadBody(response: Response) {
  try {
    return await response.text();
  } catch {
    return "<unreadable response>";
  }
}

// Deep merge utility (source wins over target for conflicts)
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (sourceVal === null || sourceVal === undefined) continue;

    if (
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal) &&
      targetVal !== null
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

// Schema-driven extraction system prompt
const EXTRACTION_SYSTEM_PROMPT = `You are an expert commercial real estate analyst. Extract structured underwriting inputs from a natural language deal description.

CRITICAL RULES:
1. NEVER invent or guess values for: purchase_price, rent amounts, exit_cap_rate, ltv_max, fixed_rate, or any debt terms
2. Only extract values explicitly stated or directly calculable from the description
3. Convert percentages to decimals (5% -> 0.05)
4. Convert years to months where appropriate (5 year hold -> 60 months, exit_month = hold_period_months)
5. For dates not specified, use reasonable estimates based on context (e.g., analysis_start_date = next month's 1st)
6. Capture reserves escalation phrases (e.g., "escalating 2.5% annually") as reserves_growth_pct

Return a JSON object with this structure:
{
  "inputs": {
    "contract": {
      "contract_version": "IND_ACQ_V1",
      "template_id": "IND_ACQ" or "IND_ACQ_MT" (use MT if more than 1 tenant)
    },
    "deal": {
      "project_name": string,
      "city": string,
      "state": string (2-letter),
      "analysis_start_date": "YYYY-MM-DD",
      "hold_period_months": number,
      "gross_sf": number,
      "net_sf": number
    },
    "acquisition": {
      "purchase_price": number,
      "closing_cost_pct": number (default 0.015)
    },
    "operating": {
      "vacancy_pct": number (default 0.05),
      "credit_loss_pct": number (default 0.02),
      "inflation": { "rent": 0.03, "expenses": 0.025, "taxes": 0.02 },
      "expenses": {
        "management_fee_pct_egi": number (default 0.04),
        "fixed_annual": {
          "reserves": number,
          "reserves_growth_pct": number
        },
        "recoveries": { "mode": "NNN" | "MOD_GROSS" | "GROSS" }
      }
    },
    "rent_roll": {
      "tenants_in_place": [
        {
          "tenant_name": string,
          "sf": number,
          "lease_start": "YYYY-MM-DD",
          "lease_end": "YYYY-MM-DD",
          "current_rent_psf_annual": number,
          "annual_bump_pct": number,
          "lease_type": "NNN" | "GROSS" | "MOD_GROSS"
        }
      ],
      "market_rollover": [  // Optional - renewal/rollover terms if mentioned
        {
          "tenant_name": string,  // e.g. "ABC Co (Renewal)"
          "market_rent_psf_annual": number,
          "annual_bump_pct": number,
          "lease_start": "YYYY-MM-DD",  // After downtime
          "lease_end": "YYYY-MM-DD",
          "lease_type": "NNN",
          "downtime_months": number,  // Vacancy between leases
          "free_rent_months": number
        }
      ]
    },
    "debt": {
      "acquisition_loan": {
        "enabled": true,
        "ltv_max": number,
        "amort_years": number (default 25),
        "io_months": number (default 12),
        "term_months": number,
        "origination_fee_pct": number (default 0.01),
        "rate": {
          "type": "FIXED",
          "fixed_rate": number
        }
      }
    },
    "exit": {
      "exit_month": number (= hold_period_months),
      "exit_cap_rate": number,
      "sale_cost_pct": number (default 0.02),
      "forward_noi_months": number (default 12)
    },
    "returns": {
      "discount_rate_unlevered": number,
      "discount_rate_levered": number
    }
  },
  "missing_fields": [
    { "path": "field.path", "description": "Human readable description" }
  ],
  "suggested_defaults": {
    "field.path": value
  }
}

PASS A - Extract explicitly stated values
PASS B - Normalize consistency:
- exit_month must equal hold_period_months
- debt.acquisition_loan.term_months should match hold_period_months if not specified
- Tenant SF should sum to net_sf (or close to it)
- Dates should be internally consistent

DISCOUNT RATE EXTRACTION:
- If user provides a discount rate without leverage qualifier, set returns.discount_rate_unlevered
- If user provides levered/unlevered discount rates explicitly, map both fields

ROLLOVER EXTRACTION:
- If user mentions "renewal", "rollover", "re-lease", or "downtime" for a tenant, extract market_rollover
- market_rollover.lease_start = tenant's lease_end + downtime_months
- ONLY extract rollover if market rent, downtime, or renewal terms are explicitly stated
- Do NOT invent rollover entries - only extract what is mentioned`;

interface ExtractionMeta {
  missing_fields: { path: string; description: string }[];
  suggested_defaults: Record<string, unknown>;
}

interface ExtractionOutput {
  status: "ok" | "needs_info" | "error";
  inputs?: Record<string, unknown>;
  missing_fields?: { path: string; description: string }[];
  suggested_defaults?: Record<string, unknown>;
  error?: string;
  tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function extractInputsFromNL(description: string): Promise<ExtractionOutput> {
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: description },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    // Capture token usage (without logging prompt content)
    const tokenUsage = response.usage ? {
      prompt_tokens: response.usage.prompt_tokens,
      completion_tokens: response.usage.completion_tokens,
      total_tokens: response.usage.total_tokens,
    } : undefined;

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { status: "error", error: "No response from OpenAI", tokenUsage };
    }

    const parsed = JSON.parse(content) as {
      inputs?: Record<string, unknown>;
      missing_fields?: { path: string; description: string }[];
      suggested_defaults?: Record<string, unknown>;
    };

    // Apply default values for non-critical fields
    const inputsWithDefaults = applyDefaults(parsed.inputs ?? {});

    // Identify missing critical fields
    const missingCritical: { path: string; description: string }[] = [];
    for (const criticalPath of CRITICAL_FIELDS) {
      if (!hasNestedValue(inputsWithDefaults, criticalPath)) {
        missingCritical.push({
          path: criticalPath,
          description: `Required: ${criticalPath.split(".").pop()?.replace(/_/g, " ")}`,
        });
      }
    }

    const allMissing = [...(parsed.missing_fields ?? []), ...missingCritical];
    const uniqueMissing = allMissing.filter(
      (item, index, self) => index === self.findIndex((t) => t.path === item.path)
    );

    return {
      status: uniqueMissing.length > 0 ? "needs_info" : "ok",
      inputs: inputsWithDefaults,
      missing_fields: uniqueMissing,
      suggested_defaults: parsed.suggested_defaults ?? {},
      tokenUsage,
    };
  } catch (error) {
    log.error("NL extraction failed", { error: String(error) });
    return { status: "error", error: String(error) };
  }
}

function applyDefaults(inputs: Record<string, unknown>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>;

  for (const [path, value] of Object.entries(DEFAULT_VALUES)) {
    if (!hasNestedValue(result, path)) {
      setNestedValue(result, path, value);
    }
  }

  return result;
}

function hasNestedValue(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current !== null && current !== undefined;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

// Auto-generate market_rollover entries when tenant leases expire before exit
// This prevents $0 NOI at exit which causes model calculation failures
function ensureRolloverCoverage(inputs: Record<string, unknown>): { inputs: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const result = JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>;

  const deal = result.deal as Record<string, unknown> | undefined;
  const rentRoll = result.rent_roll as Record<string, unknown> | undefined;
  const exitConfig = result.exit as Record<string, unknown> | undefined;

  if (!deal || !rentRoll || !exitConfig) {
    return { inputs: result, warnings };
  }

  const analysisStartStr = deal.analysis_start_date as string | undefined;
  const holdPeriodMonths = deal.hold_period_months as number | undefined;
  const exitMonth = exitConfig.exit_month as number | undefined;

  if (!analysisStartStr || !holdPeriodMonths) {
    return { inputs: result, warnings };
  }

  // Parse analysis start date
  const analysisStart = new Date(analysisStartStr);
  if (isNaN(analysisStart.getTime())) {
    return { inputs: result, warnings };
  }

  // Calculate exit date
  const exitDate = new Date(analysisStart);
  exitDate.setMonth(exitDate.getMonth() + (exitMonth ?? holdPeriodMonths));

  const tenantsInPlace = rentRoll.tenants_in_place as Array<Record<string, unknown>> | undefined;
  let marketRollover = rentRoll.market_rollover as Array<Record<string, unknown>> | undefined;

  if (!tenantsInPlace || tenantsInPlace.length === 0) {
    return { inputs: result, warnings };
  }

  if (!marketRollover) {
    marketRollover = [];
  }

  // Check each tenant's lease expiry
  for (const tenant of tenantsInPlace) {
    const tenantName = tenant.tenant_name as string;
    const leaseEndStr = tenant.lease_end as string | undefined;
    const sf = tenant.sf as number;
    const currentRent = tenant.current_rent_psf_annual as number;
    const bumpPct = tenant.annual_bump_pct as number | undefined;
    const leaseType = tenant.lease_type as string | undefined;

    if (!leaseEndStr || !tenantName) continue;

    const leaseEnd = new Date(leaseEndStr);
    if (isNaN(leaseEnd.getTime())) continue;

    // Check if lease expires before exit
    if (leaseEnd < exitDate) {
      // Check if rollover already exists for this tenant
      const existingRollover = marketRollover.find(
        (r) => (r.tenant_name as string)?.toLowerCase().includes(tenantName.toLowerCase())
      );

      if (!existingRollover) {
        // Calculate rollover start (lease_end + 1 month downtime)
        const rolloverStart = new Date(leaseEnd);
        rolloverStart.setMonth(rolloverStart.getMonth() + 1);

        // Rollover end is exit date + 12 months (to ensure forward NOI coverage)
        const rolloverEnd = new Date(exitDate);
        rolloverEnd.setMonth(rolloverEnd.getMonth() + 12);

        // Estimate market rent at rollover (current rent with annual bumps to lease end)
        const yearsToLeaseEnd = Math.max(0, (leaseEnd.getTime() - analysisStart.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        const inflatedRent = currentRent * Math.pow(1 + (bumpPct ?? 0.03), yearsToLeaseEnd);
        // Add 5% market bump for new lease
        const marketRent = Math.round(inflatedRent * 1.05 * 100) / 100;

        const rolloverEntry = {
          tenant_name: `${tenantName} (Renewal)`,
          sf: sf,
          market_rent_psf_annual: marketRent,
          annual_bump_pct: bumpPct ?? 0.03,
          lease_start: rolloverStart.toISOString().split("T")[0],
          lease_end: rolloverEnd.toISOString().split("T")[0],
          lease_type: leaseType ?? "NNN",
          downtime_months: 1,
          free_rent_months: 0,
        };

        marketRollover.push(rolloverEntry);
        warnings.push(
          `Auto-generated rollover for ${tenantName}: lease expires ${leaseEndStr} before exit. ` +
          `Assumed renewal at $${marketRent.toFixed(2)} PSF (market) with 1 month downtime.`
        );
      }
    }
  }

  // Update rent_roll with rollover entries
  if (marketRollover.length > 0) {
    (result.rent_roll as Record<string, unknown>).market_rollover = marketRollover;
  }

  return { inputs: result, warnings };
}

type ValidationResult =
  | { status: "ok" }
  | { status: "invalid"; errors: { path: string; message: string }[] };

type ToolResult =
  | ValidationResult
  | { status: "needs_info"; inputs: Record<string, unknown>; missing_fields: { path: string; description: string }[]; suggested_defaults: Record<string, unknown>; rollover_notes?: string[] }
  | { status: "ok"; inputs: Record<string, unknown>; missing_fields: { path: string; description: string }[]; suggested_defaults: Record<string, unknown>; rollover_notes?: string[] }
  | { status: "started"; job_id: string; rollover_notes?: string[] }
  | { status: "pending"; job_id: string }
  | { status: "running"; job_id: string }
  | {
      status: "complete";
      job_id: string;
      outputs: Record<string, unknown>;
      file_path: string | null;
      download_url: string | null;
      download_url_expiry: string | null;
      warning?: string | null;
      deal_engine_validation?: ValidationComparison;
    }
  | { status: "failed"; job_id?: string; error: string };

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createIndAcqServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`IND_ACQ MCP server listening on http://localhost:${PORT}${MCP_PATH}`);
});
