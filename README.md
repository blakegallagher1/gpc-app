# gpc-app

Commercial Real Estate Underwriting Platform with OpenAI Apps SDK + MCP

## Overview

This platform provides institutional-quality CRE underwriting through:

- **Excel Engine** (.NET 8) - Generates financial models from templates
- **MCP Server** (Node.js 20) - Model Context Protocol server for ChatGPT integration
- **Widget** (Next.js) - Web UI for inputs and results

## Quick Start

```bash
# Install dependencies
pnpm install

# Start all services (3 terminals)
# Terminal 1: Excel Engine
cd services/excel-engine && dotnet run

# Terminal 2: MCP Server
pnpm --filter @gpc/mcp-server dev

# Terminal 3: Widget
pnpm --filter @gpc/widget dev
```

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for detailed setup instructions.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Vercel         │     │  Render         │     │  Render         │
│  Widget UI      │◄────│  MCP Server     │────►│  Excel Engine   │
│  (Next.js)      │     │  (Node.js 20)   │     │  (.NET 8 LTS)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  Backblaze B2   │
                                                │  (Native API)   │
                                                └─────────────────┘
```

## Project Structure

```
gpc-app/
├── services/
│   ├── excel-engine/      # .NET 8 Excel manipulation service
│   └── mcp-server/        # MCP protocol server (Node.js)
├── web/
│   └── widget/            # Next.js underwriting widget
├── contracts/             # API contracts and mappings
├── templates/             # Excel templates
├── testcases/             # Regression test cases
├── docs/
│   └── RUNBOOK.md         # Operations runbook
└── render.yaml            # Render Blueprint deployment
```

## Requirements

- Node.js v20+
- .NET 8.0 LTS
- pnpm v8+

## Deployment

| Service | Platform | URL |
|---------|----------|-----|
| Widget | Vercel | `vercel deploy --prod` |
| MCP Server | Render | Blueprint auto-deploy |
| Excel Engine | Render | Blueprint auto-deploy |

See [Deployment Checklist](docs/RUNBOOK.md#deployment-checklist) for production deployment.

## Documentation

- [RUNBOOK.md](docs/RUNBOOK.md) - Operations runbook, environment variables, troubleshooting
- [Agentic CRE Architecture](docs/cre-architecture.md) - Platform architecture

## License

MIT
