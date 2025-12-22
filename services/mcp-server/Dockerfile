# Build from repo root: docker build -f services/mcp-server/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config and lockfile first for cache efficiency
COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY package.json ./

# Create service directory structure
RUN mkdir -p services/mcp-server

# Copy service package.json
COPY services/mcp-server/package.json ./services/mcp-server/

# Install dependencies (workspace mode)
RUN pnpm install --frozen-lockfile --filter @gpc/mcp-server... || pnpm install --filter @gpc/mcp-server...

# Copy source
COPY services/mcp-server/ ./services/mcp-server/

# Build TypeScript
WORKDIR /app/services/mcp-server
RUN pnpm build

FROM node:20-alpine AS final
WORKDIR /app

# Copy package files and built code from the service directory
COPY --from=build /app/services/mcp-server/package.json ./
COPY --from=build /app/services/mcp-server/node_modules ./node_modules
COPY --from=build /app/services/mcp-server/dist ./dist

# Copy contracts from repo
COPY contracts ./contracts

# Environment
ENV NODE_ENV=production
ENV PORT=8000
ENV CONTRACTS_DIR=/app/contracts

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:8000/health || exit 1

EXPOSE 8000
CMD ["node", "dist/index.js"]
