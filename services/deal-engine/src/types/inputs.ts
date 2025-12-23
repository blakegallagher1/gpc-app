// TypeScript types matching contracts/deal_engine_v0.schema.json

export interface DealEngineInputs {
  contract: ContractInput;
  deal: DealInput;
  modules: ModulesInput;
}

export interface ContractInput {
  contract_version: "DEAL_ENGINE_V0";
  engine_version: string;
}

export interface DealInput {
  project_name: string;
  city: string;
  state: string;
  analysis_start_date: string;
  hold_period_months: number;
  gross_sf: number;
  net_sf: number;
}

export interface ModulesInput {
  acquisition: AcquisitionInput;
  lease: LeaseInput;
  operating?: OperatingInput;
  debt?: DebtInput;
  exit: ExitInput;
  waterfall?: WaterfallInput;
  scenario?: ScenarioInput;
}

export interface AcquisitionInput {
  purchase_price: number;
  closing_cost_pct: number;
  close_month?: number;
  option_fee?: number;
  reserves_at_closing?: number;
}

export type LeaseType = "NNN" | "MOD_GROSS" | "GROSS";

export type TenantImprovementMode = "PER_SF" | "FIXED";

export interface TenantImprovementInput {
  mode?: TenantImprovementMode;
  value?: number;
}

export type LeasingCommissionMode = "PCT_RENT" | "PER_SF" | "FIXED";

export interface LeasingCommissionInput {
  mode?: LeasingCommissionMode;
  value?: number;
}

export interface InPlaceTenantInput {
  tenant_name: string;
  sf: number;
  lease_start: string;
  lease_end: string;
  current_rent_psf_annual: number;
  annual_bump_pct?: number;
  lease_type?: LeaseType;
  stop_amount_annual?: number;
  free_rent_months?: number;
  ti?: TenantImprovementInput;
  lc?: LeasingCommissionInput;
  comments?: string;
}

export interface MarketRolloverTenantInput {
  tenant_name: string;
  sf?: number;
  market_rent_psf_annual: number;
  annual_bump_pct?: number;
  lease_start: string;
  lease_end: string;
  lease_type?: LeaseType;
  stop_amount_annual?: number;
  free_rent_months?: number;
  downtime_months?: number;
  ti?: TenantImprovementInput;
  lc?: LeasingCommissionInput;
}

export interface LeaseInput {
  tenants_in_place: InPlaceTenantInput[];
  market_rollover?: MarketRolloverTenantInput[];
}

export interface OperatingInflationInput {
  rent: number;
  expenses: number;
  taxes: number;
}

export interface OperatingRecoveriesInput {
  mode: LeaseType;
}

export interface OperatingExpensesInput {
  recoveries: OperatingRecoveriesInput;
}

export interface OperatingInput {
  vacancy_pct: number;
  credit_loss_pct: number;
  inflation: OperatingInflationInput;
  expenses: OperatingExpensesInput;
}

export interface AcquisitionLoanInput {
  ltv_max: number;
  rate: number;
  amort_years: number;
  io_months: number;
  term_months: number;
}

export interface DebtInput {
  acquisition_loan: AcquisitionLoanInput;
}

export interface ExitInput {
  exit_cap_rate: number;
  exit_month: number;
  sale_cost_pct: number;
  forward_noi_months?: number;
}

export interface WaterfallTierInput {
  hurdle_irr: number;
  promote_split: number;
}

export type WaterfallInput =
  | {
      enabled: false;
      tiers?: WaterfallTierInput[];
    }
  | {
      enabled: true;
      tiers: WaterfallTierInput[];
    };

export interface ScenarioExitCapRangeInput {
  low: number;
  high: number;
  step: number;
}

export interface ScenarioExitMonthRangeInput {
  low: number;
  high: number;
  step: number;
}

export type ScenarioInput =
  | {
      enabled: false;
      exit_cap_range?: ScenarioExitCapRangeInput;
      exit_month_range?: ScenarioExitMonthRangeInput;
    }
  | {
      enabled: true;
      exit_cap_range: ScenarioExitCapRangeInput;
      exit_month_range: ScenarioExitMonthRangeInput;
    };
