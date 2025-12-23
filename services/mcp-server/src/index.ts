import { createServer, type IncomingMessage } from "node:http";
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
const RATE_LIMIT_WINDOW_SEC = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 60);
const RATE_LIMIT_MAX_REQUESTS_PER_SESSION = Number(process.env.RATE_LIMIT_MAX_REQUESTS_PER_SESSION ?? 30);

// Cache build inputs for optional Deal Engine validation (keyed by job_id)
const indAcqInputsByJobId = new Map<string, Record<string, unknown>>();
const dealEngineValidationByJobId = new Map<string, ValidationComparison>();
const appliedDefaultsByJobId = new Map<string, AppliedDefault[]>();

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

type RateLimitResult = { allowed: boolean; remaining: number; resetMs: number };

class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly entries = new Map<string, { windowStart: number; count: number }>();
  private lastCleanup = Date.now();
  private readonly cleanupIntervalMs = 5 * 60 * 1000;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  allow(key: string, now = Date.now()): RateLimitResult {
    const entry = this.entries.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { windowStart: now, count: 1 });
      this.cleanupIfNeeded(now);
      return { allowed: true, remaining: Math.max(0, this.maxRequests - 1), resetMs: this.windowMs };
    }

    if (entry.count >= this.maxRequests) {
      this.cleanupIfNeeded(now);
      return { allowed: false, remaining: 0, resetMs: Math.max(0, this.windowMs - (now - entry.windowStart)) };
    }

    entry.count += 1;
    this.cleanupIfNeeded(now);
    return { allowed: true, remaining: Math.max(0, this.maxRequests - entry.count), resetMs: Math.max(0, this.windowMs - (now - entry.windowStart)) };
  }

  private cleanupIfNeeded(now: number): void {
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    for (const [key, entry] of this.entries.entries()) {
      if (now - entry.windowStart >= this.windowMs * 2) {
        this.entries.delete(key);
      }
    }
    this.lastCleanup = now;
  }
}

const ipLimiter = new RateLimiter(RATE_LIMIT_WINDOW_SEC * 1000, RATE_LIMIT_MAX_REQUESTS);
const sessionLimiter = new RateLimiter(RATE_LIMIT_WINDOW_SEC * 1000, RATE_LIMIT_MAX_REQUESTS_PER_SESSION);

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) {
    return realIp;
  }
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.length > 0) {
    return cfIp;
  }
  return req.socket.remoteAddress ?? "unknown";
}

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

// Non-critical fields with sensible defaults
const DEFAULT_VALUES: Record<string, unknown> = {
  "contract.contract_version": "IND_ACQ_V1",
  "contract.template_id": "IND_ACQ",
  "contract.currency": "USD",
  "deal.project_name": "Untitled Deal",
  "deal.city": "Unknown",
  "deal.state": "TX",
  "deal.hold_period_months": 60,
  "acquisition.closing_cost_pct": 0.02,
  "operating.vacancy_pct": 0.05,
  "operating.credit_loss_pct": 0,
  "operating.inflation.rent": 0.03,
  "operating.inflation.expenses": 0.03,
  "operating.inflation.taxes": 0.02,
  "operating.expenses.management_fee_pct_egi": 0,
  "operating.expenses.fixed_annual.reserves": 0,
  "operating.expenses.fixed_annual.reserves_growth_pct": 0,
  "operating.expenses.fixed_annual.other_operating": 0,
  "operating.expenses.fixed_annual.other_operating_growth_pct": 0,
  "operating.expenses.fixed_annual.insurance": 0,
  "operating.expenses.fixed_annual.utilities": 0,
  "operating.expenses.fixed_annual.repairs_maintenance": 0,
  "operating.expenses.fixed_annual.security": 0,
  "operating.expenses.fixed_annual.property_taxes": 0,
  "operating.expenses.fixed_annual.other_expense_1": 0,
  "operating.expenses.recoveries.mode": "NNN",
  "debt.acquisition_loan.enabled": true,
  "debt.acquisition_loan.ltv_max": 0.65,
  "debt.acquisition_loan.amort_years": 25,
  "debt.acquisition_loan.io_months": 0,
  "debt.acquisition_loan.origination_fee_pct": 0.01,
  "debt.acquisition_loan.rate.type": "FIXED",
  "debt.acquisition_loan.rate.fixed_rate": 0.065,
  "debt.acquisition_loan.funding.fund_renovation_pct": 0,
  "debt.acquisition_loan.funding.fund_ti_lc_pct": 0,
  "debt.acquisition_loan.funding.fund_capex_pct": 0,
  "debt.acquisition_loan.funding.ti_lc_holdback_amount": 0,
  "exit.exit_cap_rate": 0.075,
  "exit.sale_cost_pct": 0.02,
  "exit.forward_noi_months": 12,
  "returns.discount_rate_unlevered": 0.09,
  "returns.discount_rate_levered": 0.09,
};

const DEFAULT_REASONS: Record<string, string> = {
  "deal.project_name": "Not specified; assumed \"Untitled Deal\"",
  "deal.city": "Not specified; assumed \"Unknown\"",
  "deal.state": "Not specified; assumed \"TX\"",
  "deal.hold_period_months": "Hold period not specified; assumed 60 months",
  "deal.analysis_start_date": "Start date not specified; assumed first of next month",
  "deal.net_sf": "Net SF not specified; assumed equal to gross_sf",
  "deal.gross_sf": "Gross SF not specified; assumed equal to net_sf",
  "acquisition.closing_cost_pct": "Not specified; assumed 2%",
  "operating.vacancy_pct": "Not specified; assumed 5%",
  "operating.credit_loss_pct": "Not specified; assumed 0%",
  "operating.inflation.rent": "Not specified; assumed 3% annual rent growth",
  "operating.inflation.expenses": "Not specified; assumed 3% annual expense growth",
  "operating.inflation.taxes": "Not specified; assumed 2% annual tax growth",
  "operating.expenses.management_fee_pct_egi": "Not specified; assumed 0% for NNN lease",
  "operating.expenses.fixed_annual.reserves": "Not specified; assumed 0",
  "operating.expenses.fixed_annual.reserves_growth_pct": "Not specified; assumed 0% annual growth",
  "operating.expenses.fixed_annual.other_operating": "Not specified; assumed 0",
  "operating.expenses.fixed_annual.other_operating_growth_pct": "Not specified; assumed 0% annual growth",
  "operating.expenses.fixed_annual.insurance": "Not specified; assumed 0",
  "operating.expenses.fixed_annual.utilities": "Not specified; assumed 0",
  "operating.expenses.fixed_annual.repairs_maintenance": "Not specified; assumed 0",
  "operating.expenses.fixed_annual.security": "Not specified; assumed 0",
  "operating.expenses.fixed_annual.property_taxes": "Not specified; assumed 0",
  "operating.expenses.fixed_annual.other_expense_1": "Not specified; assumed 0",
  "operating.expenses.recoveries.mode": "Not specified; assumed NNN",
  "debt.acquisition_loan.enabled": "Not specified; assumed enabled",
  "debt.acquisition_loan.ltv_max": "Not specified; assumed 65% LTV",
  "debt.acquisition_loan.amort_years": "Not specified; assumed 25-year amortization",
  "debt.acquisition_loan.io_months": "Interest-only period not specified; assumed 0 months",
  "debt.acquisition_loan.term_months": "Loan term not specified; assumed hold period",
  "debt.acquisition_loan.origination_fee_pct": "Not specified; assumed 1%",
  "debt.acquisition_loan.rate.type": "Not specified; assumed FIXED",
  "debt.acquisition_loan.rate.fixed_rate": "Not specified; assumed 6.5%",
  "debt.acquisition_loan.funding.fund_renovation_pct": "Not specified; assumed 0% funding for renovation costs",
  "debt.acquisition_loan.funding.fund_ti_lc_pct": "Not specified; assumed 0% funding for TI/LC",
  "debt.acquisition_loan.funding.fund_capex_pct": "Not specified; assumed 0% funding for CapEx",
  "debt.acquisition_loan.funding.ti_lc_holdback_amount": "Not specified; assumed 0 holdback",
  "exit.exit_month": "Exit month not specified; assumed hold period",
  "exit.exit_cap_rate": "Not specified; assumed 7.5%",
  "exit.sale_cost_pct": "Not specified; assumed 2%",
  "exit.forward_noi_months": "Not specified; assumed 12 months",
  "returns.discount_rate_unlevered": "Not specified; assumed 9%",
  "returns.discount_rate_levered": "Not specified; assumed 9%",
};

const VALID_FIELD_HINTS: Record<string, string[]> = {
  "/operating/expenses/fixed_annual": [
    "insurance",
    "utilities",
    "repairs_maintenance",
    "security",
    "property_taxes",
    "other_expense_1",
    "reserves",
    "reserves_growth_pct",
    "other_operating",
    "other_operating_growth_pct",
  ],
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
  scenario?: {
    baseCase: Record<string, unknown>;
    grid: Record<string, unknown>;
    exitCapRates: number[];
    exitMonths: number[];
    interestRates?: number[];
  };
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

    const scenarioConfig = (transformed.modules as Record<string, unknown>)?.scenario as
      | Record<string, unknown>
      | undefined;
    const scenarioEnabled = scenarioConfig?.enabled === true;
    const scenarioOutputs = scenarioEnabled
      ? (result.context.outputs.scenario as Record<string, unknown> | undefined)
      : undefined;

    return {
      enabled: true,
      dealEngineSuccess: true,
      discrepancies: discrepancies.length > 0 ? discrepancies : undefined,
      scenario: scenarioOutputs
        ? {
            baseCase: (scenarioOutputs.baseCase as Record<string, unknown>) ?? {},
            grid: (scenarioOutputs.grid as Record<string, unknown>) ?? [],
            exitCapRates: (scenarioOutputs.exitCapRates as number[]) ?? [],
            exitMonths: (scenarioOutputs.exitMonths as number[]) ?? [],
            interestRates: (scenarioOutputs.interestRates as number[]) ?? [],
          }
        : undefined,
    };
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
      let appliedDefaults: AppliedDefault[] = [];

      // Check if this is an NL-only call (natural_language present, inputs missing/empty)
      const hasNL = args.natural_language && typeof args.natural_language === "string" && args.natural_language.trim();
      const hasInputs = args.inputs && Object.keys(args.inputs).length > 0;

      // Default to run; only use extract_only if explicitly requested
      const mode = args.mode ?? "run";

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

        } catch (error) {
          return buildToolResponse({
            status: "failed",
            error: `NL extraction failed: ${String(error)}`,
          });
        }
      }

      // Normalize and apply defaults before any missing-field checks
      const normalizedInputs = normalizeInputs(mergedInputs);
      const defaultsResult = applyDefaults(normalizedInputs);
      mergedInputs = defaultsResult.mergedInputs;
      appliedDefaults = defaultsResult.appliedDefaults;

      const missingRequired = getMissingRequiredFields(mergedInputs);
      if (missingRequired.length > 0) {
        return buildToolResponse({
          status: "needs_info",
          inputs: mergedInputs,
          missing_fields: missingRequired,
          suggested_defaults: extractionMeta?.suggested_defaults ?? {},
          assumptions_applied: appliedDefaults,
        });
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
        const validation = validateInputs(mergedInputs);
        if (validation.status === "invalid") {
          return buildToolResponse(validation);
        }

        return buildToolResponse({
          status: "ok",
          inputs: mergedInputs,
          missing_fields: [],
          suggested_defaults: extractionMeta?.suggested_defaults ?? {},
          assumptions_applied: appliedDefaults,
          ...(rolloverWarnings.length > 0 ? { rollover_notes: rolloverWarnings } : {}),
        });
      }

      // mode === "run" - validate and build
      let validation = validateInputs(mergedInputs);
      if (validation.status === "invalid") {
        const normalizedRetry = normalizeInputs(mergedInputs);
        if (normalizedRetry !== mergedInputs) {
          mergedInputs = normalizedRetry;
        }
        validation = validateInputs(mergedInputs);
        if (validation.status === "invalid") {
          return buildToolResponse(validation);
        }
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

      appliedDefaultsByJobId.set(payload.job_id, appliedDefaults);

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
        const assumptionsApplied = appliedDefaultsByJobId.get(jobId) ?? [];
        appliedDefaultsByJobId.delete(jobId);
        const guidance = buildGuidance(assumptionsApplied);

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
          assumptions_applied: assumptionsApplied,
          guidance,
        });
      }

      if (status === "failed") {
        indAcqInputsByJobId.delete(jobId);
        dealEngineValidationByJobId.delete(jobId);
        appliedDefaultsByJobId.delete(jobId);
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
    const errors = (validateInputsContract.errors ?? []).map((error: Record<string, unknown>) => formatValidationError(error));
    return { status: "invalid", errors };
  }
  return { status: "ok" };
}

function formatValidationError(error: Record<string, unknown>): { path: string; message: string } {
  const instancePath = (error.instancePath as string | undefined) ?? "";
  const keyword = (error.keyword as string | undefined) ?? "";
  const params = (error.params as Record<string, unknown> | undefined) ?? {};
  const basePath = formatInstancePath(instancePath);

  if (keyword === "required") {
    const missingProperty = params.missingProperty as string | undefined;
    const path = missingProperty ? (basePath ? `${basePath}.${missingProperty}` : missingProperty) : basePath || "/";
    return { path, message: `Missing required field '${missingProperty ?? "unknown"}'.` };
  }

  if (keyword === "additionalProperties") {
    const additional = params.additionalProperty as string | undefined;
    const path = additional ? (basePath ? `${basePath}.${additional}` : additional) : basePath || "/";
    const validFields = VALID_FIELD_HINTS[instancePath] ?? [];
    const suggestion = validFields.length > 0
      ? ` Did you mean '${validFields.slice(0, 2).join("' or '")}'? Valid fields are: ${validFields.join(", ")}.`
      : "";
    return { path, message: `Unknown field '${additional ?? "unknown"}'.${suggestion}` };
  }

  return { path: basePath || "/", message: (error.message as string | undefined) ?? "Invalid value." };
}

function formatInstancePath(instancePath: string): string {
  if (!instancePath) return "";
  return instancePath.replace(/\//g, ".").replace(/^\./, "");
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
      ...(result.deal_engine_validation?.scenario
        ? { scenario: result.deal_engine_validation.scenario }
        : {}),
      ...(result.assumptions_applied ? { assumptions_applied: result.assumptions_applied } : {}),
      ...(result.guidance ? { guidance: result.guidance } : {}),
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
6. Use the EXACT field paths shown below (schema is strict; unknown fields will fail)
7. If operating expenses or reserves are stated as $/SF/year, convert to total annual $ using net_sf (or gross_sf if net_sf missing)
8. Capture reserves escalation phrases (e.g., "escalating 2.5% annually") as reserves_growth_pct

FIELD MAPPING (use these exact paths):
- Operating expenses ($/SF/year stated) → operating.expenses.fixed_annual.other_operating = $/SF * net_sf
- Operating expense growth → operating.expenses.fixed_annual.other_operating_growth_pct
- Reserves ($/SF/year stated) → operating.expenses.fixed_annual.reserves = $/SF * net_sf
- Reserves growth → operating.expenses.fixed_annual.reserves_growth_pct
- Do NOT use capex_reserves_per_nsf_annual for reserves
- Discount rate → returns.discount_rate_unlevered AND returns.discount_rate_levered
- Vacancy → operating.vacancy_pct
- Credit loss → operating.credit_loss_pct (default 0 if not stated)
- Management fee → operating.expenses.management_fee_pct_egi (default 0 if not stated for NNN)

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
      "closing_cost_pct": number (default 0.02)
    },
    "operating": {
      "vacancy_pct": number (default 0.05),
      "credit_loss_pct": number (default 0),
      "inflation": { "rent": 0.03, "expenses": 0.03, "taxes": 0.02 },
      "expenses": {
        "management_fee_pct_egi": number (default 0),
        "fixed_annual": {
          "reserves": number,
          "reserves_growth_pct": number,
          "other_operating": number,
          "other_operating_growth_pct": number
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
        "io_months": number (default 0),
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
- If user provides a discount rate without leverage qualifier, set BOTH returns.discount_rate_unlevered and returns.discount_rate_levered
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

interface AppliedDefault {
  field: string;
  value: unknown;
  reason: string;
}

interface Guidance {
  message: string;
  editable_cells: { field: string; cell: string }[];
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

    const defaultsResult = applyDefaults(normalizeInputs(parsed.inputs ?? {}));
    const inputsWithDefaults = defaultsResult.mergedInputs;
    const requiredMissing = getMissingRequiredFields(inputsWithDefaults);

    return {
      status: requiredMissing.length > 0 ? "needs_info" : "ok",
      inputs: inputsWithDefaults,
      missing_fields: requiredMissing,
      suggested_defaults: parsed.suggested_defaults ?? {},
      tokenUsage,
    };
  } catch (error) {
    log.error("NL extraction failed", { error: String(error) });
    return { status: "error", error: String(error) };
  }
}

function applyDefaults(inputs: Record<string, unknown>): { mergedInputs: Record<string, unknown>; appliedDefaults: AppliedDefault[] } {
  const result = JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>;
  const appliedDefaults: AppliedDefault[] = [];

  for (const [path, value] of Object.entries(DEFAULT_VALUES)) {
    if (!hasNestedValue(result, path)) {
      setNestedValue(result, path, value);
      appliedDefaults.push({
        field: path,
        value,
        reason: DEFAULT_REASONS[path] ?? "Not specified; default applied",
      });
    }
  }

  if (!hasNestedValue(result, "deal.analysis_start_date")) {
    const startDate = getFirstDayOfNextMonth();
    setNestedValue(result, "deal.analysis_start_date", startDate);
    appliedDefaults.push({
      field: "deal.analysis_start_date",
      value: startDate,
      reason: DEFAULT_REASONS["deal.analysis_start_date"] ?? "Not specified; default applied",
    });
  }

  const grossSf = getNestedNumber(result, "deal.gross_sf");
  const netSf = getNestedNumber(result, "deal.net_sf");

  if (grossSf == null && netSf != null) {
    setNestedValue(result, "deal.gross_sf", netSf);
    appliedDefaults.push({
      field: "deal.gross_sf",
      value: netSf,
      reason: DEFAULT_REASONS["deal.gross_sf"] ?? "Not specified; default applied",
    });
  }

  if (netSf == null && grossSf != null) {
    setNestedValue(result, "deal.net_sf", grossSf);
    appliedDefaults.push({
      field: "deal.net_sf",
      value: grossSf,
      reason: DEFAULT_REASONS["deal.net_sf"] ?? "Not specified; default applied",
    });
  }

  const holdPeriod = getNestedNumber(result, "deal.hold_period_months") ?? 60;
  if (!hasNestedValue(result, "exit.exit_month")) {
    setNestedValue(result, "exit.exit_month", holdPeriod);
    appliedDefaults.push({
      field: "exit.exit_month",
      value: holdPeriod,
      reason: DEFAULT_REASONS["exit.exit_month"] ?? "Not specified; default applied",
    });
  }

  if (!hasNestedValue(result, "debt.acquisition_loan.term_months")) {
    setNestedValue(result, "debt.acquisition_loan.term_months", holdPeriod);
    appliedDefaults.push({
      field: "debt.acquisition_loan.term_months",
      value: holdPeriod,
      reason: DEFAULT_REASONS["debt.acquisition_loan.term_months"] ?? "Not specified; default applied",
    });
  }

  return { mergedInputs: result, appliedDefaults };
}

function getMissingRequiredFields(inputs: Record<string, unknown>): { path: string; description: string }[] {
  const missing: { path: string; description: string }[] = [];
  const grossSf = getNestedNumber(inputs, "deal.gross_sf");
  const netSf = getNestedNumber(inputs, "deal.net_sf");
  const purchasePrice = getNestedNumber(inputs, "acquisition.purchase_price");
  const tenants = getNestedValue(inputs, "rent_roll.tenants_in_place");

  if (grossSf == null && netSf == null) {
    missing.push({ path: "deal.gross_sf", description: "Required: gross_sf (or provide net_sf)" });
  }

  if (purchasePrice == null) {
    missing.push({ path: "acquisition.purchase_price", description: "Required: purchase_price" });
  }

  const hasTenantRent = Array.isArray(tenants) && tenants.some((tenant) => {
    if (!tenant || typeof tenant !== "object") return false;
    const rent = (tenant as Record<string, unknown>)["current_rent_psf_annual"];
    return typeof rent === "number" && Number.isFinite(rent);
  });

  if (!hasTenantRent) {
    missing.push({
      path: "rent_roll.tenants_in_place[0].current_rent_psf_annual",
      description: "Required: tenant rent (current_rent_psf_annual)",
    });
  }

  return missing;
}

function getFirstDayOfNextMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  const monthStr = String(nextMonth + 1).padStart(2, "0");
  return `${nextYear}-${monthStr}-01`;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function getNestedNumber(obj: Record<string, unknown>, path: string): number | null {
  const value = getNestedValue(obj, path);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>;
  return normalizeValue(clone, "") as Record<string, unknown>;
}

function normalizeValue(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeValue(item, `${path}[${index}]`));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      result[key] = normalizeValue(child, nextPath);
    }
    return result;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const asNumber = parseNumericString(trimmed);
    if (asNumber !== null) {
      const normalizedNumber = normalizePercentage(asNumber, path);
      return normalizedNumber;
    }

    if (isDateField(path)) {
      const parsedDate = normalizeDateString(trimmed);
      if (parsedDate) return parsedDate;
    }

    return trimmed;
  }

  if (typeof value === "number") {
    return normalizePercentage(value, path);
  }

  return value;
}

function parseNumericString(value: string): number | null {
  const cleaned = value.replace(/[$,%]/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizePercentage(value: number, path: string): number {
  if (!isPercentField(path)) return value;
  if (value > 1 && value < 100) {
    return value / 100;
  }
  return value;
}

function isPercentField(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes("pct") ||
    lower.includes("rate") ||
    lower.includes("ltv") ||
    lower.includes("cap_rate") ||
    lower.includes("discount_rate");
}

function isDateField(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith("_date") ||
    lower.endsWith("analysis_start_date") ||
    lower.endsWith("lease_start") ||
    lower.endsWith("lease_end");
}

function normalizeDateString(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildGuidance(appliedDefaults: AppliedDefault[]): Guidance | undefined {
  if (appliedDefaults.length === 0) return undefined;
  return {
    message: "Model completed with assumptions listed above. To adjust, specify these values in your next request or download the Excel file to edit directly.",
    editable_cells: [],
  };
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
  | { status: "needs_info"; inputs: Record<string, unknown>; missing_fields: { path: string; description: string }[]; suggested_defaults: Record<string, unknown>; assumptions_applied?: AppliedDefault[]; rollover_notes?: string[] }
  | { status: "ok"; inputs: Record<string, unknown>; missing_fields: { path: string; description: string }[]; suggested_defaults: Record<string, unknown>; assumptions_applied?: AppliedDefault[]; rollover_notes?: string[] }
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
      assumptions_applied?: AppliedDefault[];
      guidance?: Guidance;
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

    const ipKey = getClientIp(req);
    const ipLimit = ipLimiter.allow(ipKey);
    if (!ipLimit.allowed) {
      const retryAfter = Math.ceil(ipLimit.resetMs / 1000);
      res.writeHead(429, {
        "content-type": "application/json",
        "Retry-After": retryAfter.toString(),
        "X-RateLimit-Limit": RATE_LIMIT_MAX_REQUESTS.toString(),
        "X-RateLimit-Remaining": ipLimit.remaining.toString(),
        "X-RateLimit-Reset": retryAfter.toString(),
      });
      res.end(JSON.stringify({ error: "rate_limited", message: "Too many requests. Please retry later." }));
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    if (typeof sessionIdHeader === "string" && sessionIdHeader.length > 0) {
      const sessionLimit = sessionLimiter.allow(sessionIdHeader);
      if (!sessionLimit.allowed) {
        const retryAfter = Math.ceil(sessionLimit.resetMs / 1000);
        res.writeHead(429, {
          "content-type": "application/json",
          "Retry-After": retryAfter.toString(),
          "X-RateLimit-Limit": RATE_LIMIT_MAX_REQUESTS.toString(),
          "X-RateLimit-Remaining": ipLimit.remaining.toString(),
          "X-RateLimit-Reset": Math.ceil(ipLimit.resetMs / 1000).toString(),
          "X-RateLimit-Session-Limit": RATE_LIMIT_MAX_REQUESTS_PER_SESSION.toString(),
          "X-RateLimit-Session-Remaining": sessionLimit.remaining.toString(),
          "X-RateLimit-Session-Reset": retryAfter.toString(),
        });
        res.end(JSON.stringify({ error: "rate_limited", message: "Session request limit exceeded. Please retry later." }));
        return;
      }
    }

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
