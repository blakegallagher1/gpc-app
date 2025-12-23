// Core primitives
export { Timeline } from "./core/timeline.js";
export type { TimelineConfig } from "./core/timeline.js";
export { Series } from "./core/series.js";
export {
  parseDate,
  monthsBetween,
  addMonths,
  isStartOfMonth,
  startOfMonth,
} from "./core/date-utils.js";
export { pmt, irr, xirr, npv, annualToMonthly, monthlyToAnnual } from "./core/math-utils.js";

// Types (all type-only exports)
export type {
  DealEngineInputs,
  ContractInput,
  DealInput,
  ModulesInput,
  AcquisitionInput,
  LeaseType,
  TenantImprovementMode,
  TenantImprovementInput,
  LeasingCommissionMode,
  LeasingCommissionInput,
  InPlaceTenantInput,
  MarketRolloverTenantInput,
  LeaseInput,
  OperatingInflationInput,
  OperatingRecoveriesInput,
  OperatingExpensesInput,
  OperatingInput,
  AcquisitionLoanInput,
  DebtInput,
  ExitInput,
  WaterfallTierInput,
  WaterfallLpClassInput,
  WaterfallInput,
  ScenarioExitCapRangeInput,
  ScenarioExitMonthRangeInput,
  ScenarioInput,
} from "./types/inputs.js";
export type { DealContext, DealMetrics } from "./types/context.js";
export type { ValidationResult, ValidationError, ModuleResult, Module } from "./types/module.js";

// Modules
export { LeaseModule } from "./modules/lease/lease-module.js";
export type { LeaseModuleOutputs, TenantSchedule } from "./modules/lease/lease-module.js";
export { OperatingModule } from "./modules/operating/operating-module.js";
export type { OperatingModuleOutputs } from "./modules/operating/operating-module.js";
export { DebtModule } from "./modules/debt/debt-module.js";
export type { DebtModuleOutputs } from "./modules/debt/debt-module.js";
export { ExitModule } from "./modules/exit/exit-module.js";
export type { ExitModuleOutputs } from "./modules/exit/exit-module.js";
export { WaterfallModule } from "./modules/waterfall/waterfall-module.js";
export type { WaterfallModuleOutputs } from "./modules/waterfall/waterfall-module.js";
export { ScenarioRunner } from "./modules/scenario/scenario-runner.js";
export type { ScenarioRunnerOutputs, ScenarioCell } from "./modules/scenario/scenario-runner.js";

// Engine
export { DealEngine, createSummaryReport } from "./engine/deal-engine.js";
export type { DealEngineResult, DealEngineValidation } from "./engine/deal-engine.js";
