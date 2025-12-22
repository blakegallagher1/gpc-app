# Excel Engine - .NET 8 LTS
# Build from repo root: docker build -f services/excel-engine/Dockerfile .
# Run:   docker run -p 5001:5001 excel-engine

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Copy project file and restore
COPY services/excel-engine/excel-engine.csproj .
RUN dotnet restore

# Copy source and build
COPY services/excel-engine/ .
RUN dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Configure for production
ENV ASPNETCORE_URLS=http://0.0.0.0:5001
ENV ASPNETCORE_ENVIRONMENT=Production

# Copy published app
COPY --from=build /app/publish .

# Copy templates from repo root
COPY templates ./templates

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:5001/health || exit 1

EXPOSE 5001
ENTRYPOINT ["dotnet", "excel-engine.dll"]
