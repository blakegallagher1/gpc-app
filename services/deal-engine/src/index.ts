// Core primitives
export { Timeline } from "./core/timeline";
export type { TimelineConfig } from "./core/timeline";
export { Series } from "./core/series";
export {
  parseDate,
  monthsBetween,
  addMonths,
  isStartOfMonth,
  startOfMonth,
} from "./core/date-utils";
export { pmt, irr, xirr, npv, annualToMonthly, monthlyToAnnual } from "./core/math-utils";

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
  WaterfallInput,
  ScenarioExitCapRangeInput,
  ScenarioExitMonthRangeInput,
  ScenarioInput,
} from "./types/inputs";
export type { DealContext, DealMetrics } from "./types/context";
export type { ValidationResult, ValidationError, ModuleResult, Module } from "./types/module";

// Modules
export { LeaseModule } from "./modules/lease/lease-module";
export type { LeaseModuleOutputs, TenantSchedule } from "./modules/lease/lease-module";
export { OperatingModule } from "./modules/operating/operating-module";
export type { OperatingModuleOutputs } from "./modules/operating/operating-module";
export { DebtModule } from "./modules/debt/debt-module";
export type { DebtModuleOutputs } from "./modules/debt/debt-module";
export { ExitModule } from "./modules/exit/exit-module";
export type { ExitModuleOutputs } from "./modules/exit/exit-module";

// Engine
export { DealEngine, createSummaryReport } from "./engine/deal-engine";
export type { DealEngineResult, DealEngineValidation } from "./engine/deal-engine";
