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
  returns?: ReturnsInput;
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

export interface RentStepInput {
  start_date: string;
  end_date: string;
  rent_psf: number;
}

export interface InPlaceTenantInput {
  tenant_name: string;
  sf: number;
  lease_start: string;
  lease_end: string;
  current_rent_psf_annual: number;
  annual_bump_pct?: number;
  economics_mode?: "bump" | "steps";
  rent_steps?: RentStepInput[];
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
  economics_mode?: "bump" | "steps";
  rent_steps?: RentStepInput[];
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
  recoveries?: number;
}

export interface OperatingRecoveriesInput {
  mode: LeaseType;
  tax_recoverable?: boolean;
  insurance_recoverable?: boolean;
  cam_recoverable?: boolean;
  admin_fee_pct?: number;
  caps?: {
    cam_annual_increase_cap?: number;
  };
}

export interface ExpenseLineItem {
  amount_year1: number;
  growth_pct?: number;
  recoverable?: boolean;
}

export interface GranularExpensesInput {
  // Property-level expenses
  real_estate_taxes?: ExpenseLineItem;
  insurance?: ExpenseLineItem;
  cam_rm?: ExpenseLineItem;  // CAM / Repairs & Maintenance
  utilities?: ExpenseLineItem;
  management_fee?: ExpenseLineItem | { pct_of_egi: number };
  admin_general?: ExpenseLineItem;
  marketing?: ExpenseLineItem;
  payroll?: ExpenseLineItem;
  reserves?: ExpenseLineItem;
  other?: ExpenseLineItem[];
}

export interface FixedAnnualExpenses {
  reserves?: number;
  reserves_growth_pct?: number;
}

export interface OperatingExpensesInput {
  recoveries: OperatingRecoveriesInput;
  fixed_annual?: FixedAnnualExpenses;
  granular?: GranularExpensesInput;
}

export interface OperatingReserveScheduleInput {
  year: number;
  amount: number;
}

export interface OperatingInput {
  vacancy_pct: number;
  credit_loss_pct: number;
  inflation: OperatingInflationInput;
  expenses: OperatingExpensesInput;
  reserves_schedule?: OperatingReserveScheduleInput[];
}

export interface AcquisitionLoanInput {
  ltv_max: number;
  rate: number;
  amort_years: number;
  io_months: number;
  term_months: number;
}

export type DebtTrancheType = "senior" | "mezz" | "pref_equity";

export interface DebtTrancheInput {
  tranche_id: string;
  tranche_type: DebtTrancheType;
  enabled?: boolean;
  // Sizing
  sizing_mode?: "ltv" | "ltc" | "dscr" | "explicit";
  ltv_max?: number;           // For senior: % of value
  ltc_max?: number;           // % of total cost
  explicit_amount?: number;   // Explicit loan amount
  // Terms
  rate: number;               // Annual interest rate
  rate_type?: "fixed" | "floating";
  spread_over_index?: number; // For floating rate
  amort_years?: number;       // 0 or undefined = interest only
  io_months?: number;         // Interest only period
  term_months: number;
  // Fees
  origination_fee_pct?: number;
  exit_fee_pct?: number;
  // Mezz/Pref specific
  pik_rate?: number;          // Payment-in-kind interest (added to balance)
  current_pay_rate?: number;  // Cash pay portion
  // Timing
  funding_month?: number;
  // Covenants
  min_dscr?: number;
  cash_sweep_trigger_dscr?: number;
}

export interface DebtInput {
  // Legacy single loan (backwards compatible)
  acquisition_loan?: AcquisitionLoanInput;
  // Multi-tranche structure
  tranches?: DebtTrancheInput[];
  sizing_mode?: "ltv" | "dscr" | "explicit";
  explicit_loan_amount?: number;
  funding_month?: number;
  covenants?: {
    min_dscr?: number;
    cash_sweep_trigger_dscr?: number;
  };
}

export interface ExitInput {
  exit_cap_rate: number;
  exit_month: number;
  sale_cost_pct: number;
  forward_noi_months?: number;
}

export interface ReturnsInput {
  discount_rate_unlevered?: number;
  discount_rate_levered?: number;
}

export interface WaterfallTierInput {
  hurdle_irr: number;
  promote_split?: number;
  lp_split?: number;
  gp_split?: number;
  catch_up_pct?: number;
}

export interface WaterfallLpClassInput {
  class_id: string;
  equity_pct: number;
  pref_irr?: number;
  promote_split?: number;
  catch_up_pct?: number;
}

export type WaterfallInput =
  | {
      enabled: false;
      tiers?: WaterfallTierInput[];
      structure?: "pro_rata" | "tiered";
      lp_classes?: WaterfallLpClassInput[];
    }
  | {
      enabled: true;
      tiers: WaterfallTierInput[];
      structure?: "pro_rata" | "tiered";
      lp_classes?: WaterfallLpClassInput[];
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

export interface ScenarioInterestRateRangeInput {
  low: number;
  high: number;
  step: number;
}

export type ScenarioInput =
  | {
      enabled: false;
      exit_cap_range?: ScenarioExitCapRangeInput;
      exit_month_range?: ScenarioExitMonthRangeInput;
      interest_rate_range?: ScenarioInterestRateRangeInput;
    }
  | {
      enabled: true;
      exit_cap_range: ScenarioExitCapRangeInput;
      exit_month_range: ScenarioExitMonthRangeInput;
      interest_rate_range: ScenarioInterestRateRangeInput;
    };
