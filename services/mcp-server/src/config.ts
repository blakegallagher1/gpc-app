import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const EXCEL_ENGINE_BASE_URL =
  process.env.EXCEL_ENGINE_BASE_URL ?? "http://localhost:5001";

// In production (Docker), contracts are at /app/contracts
// In development, they're relative to repo root
const contractsDir = process.env.CONTRACTS_DIR ?? path.resolve(__dirname, "..", "..", "..", "contracts");

export const contractsPath = {
  inputSchema: path.join(contractsDir, "ind_acq_v1.input.schema.json"),
  outputMapping: path.join(contractsDir, "ind_acq_v1.output.mapping.json"),
};
