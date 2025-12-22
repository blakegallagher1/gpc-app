import type { IndAcqInputs, ValidationResult, BuildResult, JobStatus } from "./types";

const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL || "http://localhost:8000/mcp";
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_TIME_MS = 120000;

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content: { type: string; text: string }[];
    structuredContent: T;
  };
  error?: {
    code: number;
    message: string;
  };
}

let requestId = 0;

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
  }

  const data: JsonRpcResponse<T> = await response.json();

  if (data.error) {
    throw new Error(`MCP error: ${data.error.message}`);
  }

  if (!data.result) {
    throw new Error("MCP response missing result");
  }

  return data.result.structuredContent;
}

export async function validateInputs(inputs: IndAcqInputs): Promise<ValidationResult> {
  return callTool<ValidationResult>("ind_acq.validate_inputs", { inputs });
}

export async function buildModel(inputs: IndAcqInputs): Promise<BuildResult> {
  return callTool<BuildResult>("ind_acq.build_model", { inputs });
}

export async function getRunStatus(jobId: string): Promise<JobStatus> {
  return callTool<JobStatus>("ind_acq.get_run_status", { job_id: jobId });
}

export async function pollUntilComplete(
  jobId: string,
  onUpdate?: (status: JobStatus) => void
): Promise<JobStatus> {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    const status = await getRunStatus(jobId);
    onUpdate?.(status);

    if (status.status === "complete" || status.status === "failed") {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Job timed out after ${MAX_POLL_TIME_MS / 1000} seconds`);
}
