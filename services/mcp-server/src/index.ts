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
// B2 download URL for CSP allow-list (defaults to common Backblaze endpoints)
const B2_DOWNLOAD_URL = process.env.B2_DOWNLOAD_URL?.trim() ?? "";
const MCP_PATH = "/mcp";

// Log legacy env var usage
if (process.env.WIDGET_URL && !process.env.WIDGET_PUBLIC_URL) {
  console.warn("[WARN] Using legacy WIDGET_URL. Please migrate to WIDGET_PUBLIC_URL");
}

const validateInputsInputSchema = z.object({
  inputs: z.unknown(),
  partial: z.boolean().optional(),
});

const buildModelInputSchema = z.object({
  inputs: z.unknown(),
});

const getRunStatusInputSchema = z.object({
  job_id: z.string().min(1),
});

const extractFromNLInputSchema = z.object({
  description: z.string().min(1),
});

const toolInputJsonSchemas = {
  validate_inputs: {
    type: "object",
    additionalProperties: false,
    required: ["inputs"],
    properties: {
      inputs: { type: "object" },
      partial: { type: "boolean", description: "If true, returns missing fields instead of validation errors for incomplete inputs" },
    },
  },
  build_model: {
    type: "object",
    additionalProperties: false,
    required: ["inputs"],
    properties: {
      inputs: { type: "object" },
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
  extract_from_nl: {
    type: "object",
    additionalProperties: false,
    required: ["description"],
    properties: {
      description: { type: "string", minLength: 1 },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Initialize OpenAI client (uses OPENAI_API_KEY env var by default)
const openai = new OpenAI();
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-2024-08-06";

const inputSchema = await loadJson(contractsPath.inputSchema);
const outputMapping = await loadJson(contractsPath.outputMapping);
const validateInputsContract = ajv.compile(inputSchema);

// Build CSP directives for Apps SDK widget
function buildCsp(requestHost?: string): string {
  const widgetHost = new URL(WIDGET_PUBLIC_URL).origin;
  // Use request host in production, fallback to localhost for dev
  const mcpHost = requestHost ? `https://${requestHost}` : `http://localhost:${PORT}`;

  // Build connect-src list with B2 download URLs
  const connectSrc = [mcpHost, EXCEL_ENGINE_BASE_URL];

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
    `script-src 'self' ${widgetHost} 'unsafe-inline'`,
    `style-src 'self' ${widgetHost} 'unsafe-inline'`,
    `frame-src ${widgetHost}`,
    `connect-src ${connectSrc.join(' ')}`,
    `img-src 'self' data:`,
  ].join('; ');
}

// Widget HTML template for ChatGPT Apps SDK
function getWidgetHtml(): string {
  const csp = buildCsp();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>IND_ACQ Widget</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe src="${WIDGET_PUBLIC_URL}" allow="clipboard-write"></iframe>
</body>
</html>`;
}

function createIndAcqServer() {
  const server = new McpServer({ name: "ind-acq-mcp", version: "0.1.0" });

  // Register widget resource for ChatGPT Apps SDK
  server.resource(
    "ind-acq-widget",
    "ui://widget/ind-acq",
    {
      description: "IND_ACQ Underwriting Widget UI",
      mimeType: "text/html+skybridge",
    },
    async () => ({
      contents: [
        {
          uri: "ui://widget/ind-acq",
          mimeType: "text/html+skybridge",
          text: getWidgetHtml(),
        },
      ],
    })
  );

  server.registerTool(
    "ind_acq.validate_inputs",
    {
      title: "Validate IND_ACQ inputs",
      description: "Validates inputs for the IND_ACQ underwriting model. Use partial=true to get missing fields list instead of errors.",
      inputSchema: validateInputsInputSchema,
      _meta: {
        json_schema: toolInputJsonSchemas.validate_inputs,
        "openai/toolInvocation/invoking": "Validating underwriting inputs...",
        "openai/toolInvocation/invoked": "Input validation complete",
      },
    },
    async (args) => {
      const partialMode = args.partial === true;
      const result = validateInputs(args.inputs, partialMode);
      return buildToolResponse(result);
    }
  );

  server.registerTool(
    "ind_acq.build_model",
    {
      title: "Build IND_ACQ model",
      description: "Builds the IND_ACQ underwriting model.",
      inputSchema: buildModelInputSchema,
      _meta: {
        json_schema: toolInputJsonSchemas.build_model,
        "openai/outputTemplate": "ui://widget/ind-acq",
        "openai/toolInvocation/invoking": "Building underwriting model...",
        "openai/toolInvocation/invoked": "Model build started",
      },
    },
    async (args) => {
      const validation = validateInputs(args.inputs);
      if (validation.status === "invalid") {
        return buildToolResponse(validation);
      }

      let response: Response;
      try {
        response = await fetch(`${EXCEL_ENGINE_BASE_URL}/v1/ind-acq/build`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inputs: args.inputs, mapping: outputMapping.mapping }),
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
        return buildToolResponse({
          status: "failed",
          error: "Excel engine did not return job_id.",
        });
      }

      return buildToolResponse({
        status: "started",
        job_id: payload.job_id,
      });
    }
  );

  server.registerTool(
    "ind_acq.get_run_status",
    {
      title: "Get IND_ACQ run status",
      description: "Retrieves status for a build job.",
      inputSchema: getRunStatusInputSchema,
      _meta: {
        json_schema: toolInputJsonSchemas.get_run_status,
        "openai/outputTemplate": "ui://widget/ind-acq",
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
        return buildToolResponse({
          status: "failed",
          job_id: jobId,
          error: `Unable to reach Excel engine at ${EXCEL_ENGINE_BASE_URL}: ${String(error)}`,
        });
      }
      if (!response.ok) {
        const body = await safeReadBody(response);
        return buildToolResponse({
          status: "failed",
          job_id: jobId,
          error: `Excel engine error (${response.status}): ${body}`,
        });
      }

      const payload = await response.json();
      const status = payload?.status;

      if (status === "pending" || status === "running") {
        return buildToolResponse({ status, job_id: jobId });
      }

      if (status === "complete") {
        return buildToolResponse({
          status,
          job_id: jobId,
          outputs: payload.outputs ?? {},
          file_path: payload.file_path ?? null,
          download_url: payload.download_url ?? null,
          download_url_expiry: payload.download_url_expiry ?? null,
        });
      }

      if (status === "failed") {
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

  server.registerTool(
    "ind_acq.extract_from_nl",
    {
      title: "Extract IND_ACQ inputs from natural language",
      description: "Extracts structured IND_ACQ inputs from a natural language deal description.",
      inputSchema: extractFromNLInputSchema,
      _meta: {
        json_schema: toolInputJsonSchemas.extract_from_nl,
        "openai/toolInvocation/invoking": "Extracting deal parameters...",
        "openai/toolInvocation/invoked": "Extraction complete",
      },
    },
    async (args) => {
      const description = args.description?.trim();
      if (!description) {
        return buildExtractionResponse({
          status: "error",
          error: "Description is required.",
        });
      }

      try {
        const result = await extractInputsFromNL(description);
        return buildExtractionResponse(result);
      } catch (error) {
        return buildExtractionResponse({
          status: "error",
          error: `Extraction failed: ${String(error)}`,
        });
      }
    }
  );

  return server;
}

function validateInputs(inputs: unknown, partialMode = false): ValidationResult {
  if (!validateInputsContract(inputs)) {
    const errors = (validateInputsContract.errors ?? []).map((error: { instancePath?: string; message?: string; keyword?: string }) => ({
      path: error.instancePath || "/",
      message: error.message ?? "Invalid value.",
      keyword: error.keyword,
    }));

    // In partial mode, convert "required" errors to missing fields
    if (partialMode) {
      type ErrorEntry = { path: string; message: string; keyword?: string };
      const missingFields = errors
        .filter((e: ErrorEntry) => e.keyword === "required")
        .map((e: ErrorEntry) => ({
          path: e.path === "/" ? e.message?.match(/"([^"]+)"/)?.[1] || e.path : e.path,
          description: e.message ?? "Required field",
        }));

      const otherErrors = errors.filter((e: ErrorEntry) => e.keyword !== "required");

      if (otherErrors.length === 0) {
        return {
          status: "needs_info",
          missing_fields: missingFields,
        };
      }

      // If there are non-required errors, still return invalid
      return { status: "invalid", errors: otherErrors };
    }

    return { status: "invalid", errors };
  }

  return { status: "ok" };
}

function buildToolResponse(result: ToolResult) {
  const jobId = "job_id" in result ? result.job_id : undefined;
  return {
    content: resultToContent(result),
    structuredContent: result,
    _meta: jobId ? { job_id: jobId } : undefined,
  };
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

// System prompt for NL extraction
const EXTRACTION_SYSTEM_PROMPT = `You are an expert commercial real estate analyst. Extract structured underwriting inputs from a natural language deal description.

Output a JSON object with the following structure (only include fields mentioned in the description):
{
  "deal": {
    "project_name": string,
    "city": string,
    "state": string (2-letter code),
    "analysis_start_date": string (YYYY-MM-DD),
    "hold_period_months": number,
    "gross_sf": number,
    "net_sf": number
  },
  "acquisition": {
    "purchase_price": number
  },
  "operating": {
    "vacancy_pct": number (decimal, e.g., 0.05 for 5%),
    "expenses": {
      "management_fee_pct_egi": number (decimal)
    }
  },
  "rent_roll": {
    "tenants_in_place": [
      {
        "tenant_name": string,
        "sf": number,
        "lease_start": string (YYYY-MM-DD),
        "lease_end": string (YYYY-MM-DD),
        "current_rent_psf_annual": number,
        "annual_bump_pct": number (decimal, e.g., 0.03 for 3%),
        "lease_type": "NNN" | "GROSS" | "MODIFIED_GROSS"
      }
    ]
  },
  "debt": {
    "acquisition_loan": {
      "ltv_max": number (decimal, e.g., 0.65 for 65%),
      "rate": {
        "fixed_rate": number (decimal, e.g., 0.0575 for 5.75%)
      },
      "amort_years": number,
      "io_months": number,
      "term_months": number
    }
  },
  "exit": {
    "exit_month": number,
    "exit_cap_rate": number (decimal, e.g., 0.065 for 6.5%)
  }
}

Important rules:
1. Only include fields that are explicitly mentioned or can be reasonably inferred
2. Convert percentages to decimals (5% -> 0.05)
3. Convert years to months where appropriate (5 year hold -> 60 months)
4. Use reasonable defaults for common CRE assumptions when implied
5. If critical information is missing, still extract what you can

Also return a "missing_fields" array listing important fields that were NOT provided:
[
  { "path": "deal.purchase_price", "description": "Purchase price", "example": "$5,000,000" }
]`;

interface ExtractionResult {
  [key: string]: unknown;
  status: "extracted" | "needs_info" | "error";
  inputs?: Record<string, unknown>;
  missing_fields?: { path: string; description: string; example?: string }[];
  follow_up_question?: string;
  error?: string;
}

async function extractInputsFromNL(description: string): Promise<ExtractionResult> {
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: description },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return { status: "error", error: "No response from OpenAI" };
  }

  const parsed = JSON.parse(content) as {
    inputs: Record<string, unknown>;
    missing_fields: { path: string; description: string; example?: string }[];
  };

  // Check for critical missing fields
  const criticalMissing = parsed.missing_fields?.filter((f) =>
    ["acquisition.purchase_price", "deal.net_sf", "rent_roll.tenants_in_place"].some((p) =>
      f.path.startsWith(p)
    )
  );

  if (criticalMissing && criticalMissing.length > 0) {
    return {
      status: "needs_info",
      inputs: parsed.inputs,
      missing_fields: parsed.missing_fields,
      follow_up_question: `Please provide: ${criticalMissing.map((f) => f.description).join(", ")}`,
    };
  }

  return {
    status: "extracted",
    inputs: parsed.inputs,
    missing_fields: parsed.missing_fields,
  };
}

function buildExtractionResponse(result: ExtractionResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

type ValidationResult =
  | { status: "ok" }
  | { status: "invalid"; errors: { path: string; message: string }[] }
  | { status: "needs_info"; missing_fields: { path: string; description: string }[] };

type ToolResult =
  | ValidationResult
  | { status: "started"; job_id: string }
  | { status: "pending"; job_id: string }
  | { status: "running"; job_id: string }
  | { status: "complete"; job_id: string; outputs: Record<string, unknown>; file_path: string | null; download_url: string | null; download_url_expiry: string | null }
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
