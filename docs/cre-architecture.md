# Agentic CRE Platform Architecture (Production Target)

## Overview
This document defines the production architecture for an agentic Commercial Real Estate (CRE) platform and maps each domain capability to OpenAI Apps SDK + MCP/Agents SDK constructs. The architecture is designed for data-heavy workflows: ingestion, underwriting, scenario modeling, comps, capital stack analysis, approvals, and audit-grade reporting.

## Core Principles
- **Agentic orchestration with human-in-the-loop controls.** Critical decisions (capital structure changes, approvals) require explicit user confirmation.
- **Idempotent, observable workflows.** Every workflow is replayable with deterministic inputs, backed by audit logs.
- **Secure, compliant data handling.** Input validation, PII protection, and least-privilege access are enforced.
- **Resilient integrations.** Adaptive rate limiting, retries with backoff, and circuit breakers for external APIs.

## High-Level System Architecture

### 1) Data Ingestion & Normalization
**Responsibilities**
- Fetch external datasets (BEA, Census, LA DOTD, API.data.gov) and internal deal data.
- Validate schema, fill missing values, and standardize geospatial/temporal formats.
- Maintain raw, normalized, and feature-ready datasets.

**Components**
- **Ingestion Scheduler**: cron or queue-driven jobs.
- **Connector Adapters**: API-specific fetchers with retry/backoff and quota awareness.
- **Data Quality Pipeline**: schema validation, anomaly detection, deduplication.
- **Storage**: raw lake + normalized warehouse + feature store.

**Agents SDK Mapping**
- **Tools**: `fetch_bea_data`, `fetch_census_data`, `fetch_ladotd_data`, `fetch_api_data_gov`, `normalize_dataset`, `validate_schema`.
- **Agent**: `IngestionAgent` orchestrates fetch + validate + store, emits provenance metadata.

### 2) Underwriting & Financial Modeling
**Responsibilities**
- Standardize deal inputs (NOI, cap rate, rent roll, OpEx, debt terms).
- Produce underwriting outputs (IRR, DSCR, NPV, yield-on-cost).
- Persist model assumptions and results for auditability.

**Components**
- **Underwriting Engine**: deterministic calculators + model versioning.
- **Assumption Registry**: stores base case and overridden assumptions.
- **Scenario Runner**: applies stress tests and sensitivity bands.

**Agents SDK Mapping**
- **Tools**: `calc_underwriting`, `apply_assumptions`, `run_sensitivity`, `persist_model`.
- **Agent**: `UnderwritingAgent` executes base case + sensitivity; emits structured report artifacts.

### 3) Scenario Modeling & Forecasting
**Responsibilities**
- Evaluate macro/micro scenarios (rate shifts, vacancy changes, market growth).
- Provide probabilistic outcomes and distribution of returns.
- Support user-defined scenario templates.

**Components**
- **Scenario Library**: versioned scenario templates.
- **Forecast Engine**: Monte Carlo or deterministic scenario simulation.
- **Result Aggregator**: percentile outcomes and risk flags.

**Agents SDK Mapping**
- **Tools**: `load_scenario_template`, `run_forecast`, `aggregate_results`.
- **Agent**: `ScenarioAgent` runs forecasts and returns summary + distribution tables.

### 4) Comparable (Comps) Analysis
**Responsibilities**
- Identify and score comparable properties using geo, asset class, size, and time.
- Normalize comps for market shifts and property differences.
- Provide comp-backed valuation ranges.

**Components**
- **Comps Index**: property metadata + price history.
- **Match Engine**: similarity scoring + filters.
- **Adjustment Engine**: normalization and time-adjusted valuations.

**Agents SDK Mapping**
- **Tools**: `search_comps`, `score_comp_similarity`, `normalize_comp_values`.
- **Agent**: `CompsAgent` produces valuation bands and justification.

### 5) Capital Stack & Structuring
**Responsibilities**
- Model debt/equity structures, promote waterfalls, preferred equity.
- Validate lender constraints and coverage requirements.
- Produce allocation schedules and expected returns per tranche.

**Components**
- **Capital Stack Builder**: config-driven structure composer.
- **Waterfall Engine**: promotes, fees, and distribution logic.
- **Constraint Validator**: DSCR/LTV covenant checks.

**Agents SDK Mapping**
- **Tools**: `build_capital_stack`, `run_waterfall`, `validate_covenants`.
- **Agent**: `CapitalStackAgent` outputs tranches and cash flow schedules.

### 6) Approvals & Governance
**Responsibilities**
- Enforce approval thresholds, audit trails, and role-based signoff.
- Manage exceptions and escalation workflows.
- Record all decision points and artifacts.

**Components**
- **Approval Workflow Engine**: stages, approvals, SLA timers.
- **Policy Rules**: gating rules (e.g., IRR < threshold, DSCR < 1.25).
- **Audit Log**: immutable record of approvals and rationale.

**Agents SDK Mapping**
- **Tools**: `submit_for_approval`, `check_policy_rules`, `log_approval`.
- **Agent**: `ApprovalsAgent` manages approval chain with human confirmations.

## Agent Orchestration & Workflow

### Orchestrator Agent
**Purpose**: `DealOrchestrator` coordinates ingestion → underwriting → comps → scenario modeling → capital stack → approvals.

**Key Behaviors**
- Uses **tool calls** for deterministic operations.
- Delegates to specialized agents via **handoff**.
- Applies **human-in-the-loop checkpoints** for approval decisions.
- Tracks **state and resume** progress for long-running workflows.

### Suggested Workflow Graph
1. **IngestionAgent** pulls and validates data.
2. **UnderwritingAgent** creates base case + sensitivity.
3. **CompsAgent** produces valuation range.
4. **ScenarioAgent** runs macro stress cases.
5. **CapitalStackAgent** builds tranche structure + waterfall.
6. **ApprovalsAgent** routes final package for signoff.

## Data Model (Minimal Schema)
- **Deal**: core identifiers, location, asset class, sponsor.
- **Assumptions**: rent, cap rate, financing, exit.
- **UnderwritingResult**: IRR/NPV/DSCR outputs, cash flows.
- **ScenarioResult**: outcome distributions.
- **CompsResult**: comp set, score, adjusted values.
- **CapitalStack**: tranches, waterfall, fees.
- **ApprovalRecord**: approvals, rejections, rationale, timestamps.

## Observability & Compliance
- **Structured logging** across agents/tools with correlation IDs.
- **Metrics**: tool latency, API error rate, approval turnaround time.
- **Tracing**: end-to-end per deal workflow.
- **Audit Logs**: immutable storage with retention policies.
- **Security**: PII redaction, rate limiting, and per-tool access controls.

## Mapping to OpenAI Apps SDK + MCP
- **MCP Server** exposes tools above for deterministic operations.
- **UI Component** (ChatGPT iframe) renders deal summaries, approvals, and scenario comparisons.
- **window.openai.callTool** used for user actions (request underwriting, approve deal, etc.).
- **Agents SDK** handles multi-agent orchestration and handoffs (e.g., `DealOrchestrator` ➜ `UnderwritingAgent`).

## Implementation Notes
- Prefer **idempotent** tool endpoints (retries safe).
- Include **request/response schemas** for each tool to enforce validation.
- Gate irreversible actions (approvals, capital structure changes) behind explicit user confirmation.
- Store versioned artifacts for auditability and reproducibility.

