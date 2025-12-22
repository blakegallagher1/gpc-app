# Build from repo root: docker build -f services/mcp-server/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files from mcp-server
COPY services/mcp-server/package.json services/mcp-server/pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY services/mcp-server/ .

# Build TypeScript
RUN pnpm build

FROM node:20-alpine AS final
WORKDIR /app

# Install pnpm for production install
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files and built code
COPY --from=build /app/package.json /app/pnpm-lock.yaml* ./
COPY --from=build /app/dist ./dist

# Copy contracts from repo
COPY contracts ./contracts

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Environment
ENV NODE_ENV=production
ENV PORT=8000
ENV CONTRACTS_DIR=/app/contracts

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:8000/health || exit 1

EXPOSE 8000
CMD ["node", "dist/index.js"]
