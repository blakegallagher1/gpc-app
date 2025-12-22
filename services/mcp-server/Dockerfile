# Build from repo root: docker build -f services/mcp-server/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy only the service package.json (not workspace mode for simpler deps)
COPY services/mcp-server/package.json ./

# Install dependencies directly (no workspace)
RUN pnpm install --prod=false

# Copy source
COPY services/mcp-server/src ./src
COPY services/mcp-server/tsconfig.json ./

# Build TypeScript
RUN pnpm build

FROM node:20-alpine AS final
WORKDIR /app

# Copy package.json and install production deps only
COPY --from=build /app/package.json ./
RUN corepack enable && corepack prepare pnpm@latest --activate && pnpm install --prod

# Copy built code
COPY --from=build /app/dist ./dist

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
