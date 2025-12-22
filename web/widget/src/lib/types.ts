export interface Tenant {
  tenant_name: string;
  sf: number;
  lease_start: string;
  lease_end: string;
  current_rent_psf_annual: number;
  annual_bump_pct: number;
  lease_type: string;
  free_rent_months?: number;
  ti?: { mode: string; value: number };
  lc?: { mode: string; value: number };
  comments?: string;
}

export interface IndAcqInputs {
  contract: {
    contract_version: string;
    template_id: string;
    template_version_target: string;
    request_id: string;
    currency: string;
  };
  deal: {
    project_name: string;
    city: string;
    state: string;
    analysis_start_date: string;
    hold_period_months: number;
    gross_sf: number;
    net_sf: number;
  };
  acquisition: {
    purchase_price: number;
    closing_cost_pct: number;
    acquisition_fee_pct: number;
    legal_costs: number;
    other_financing_fees: number;
  };
  operating: {
    vacancy_pct: number;
    credit_loss_pct: number;
    inflation: {
      rent: number;
      expenses: number;
      taxes: number;
    };
    expenses: {
      management_fee_pct_egi: number;
      fixed_annual: {
        insurance?: number;
        utilities?: number;
        repairs_maintenance?: number;
        security?: number;
        property_taxes?: number;
        other_expense_1?: number;
      };
      recoveries: {
        mode: string;
      };
      capex_reserves_per_nsf_annual?: number;
    };
  };
  rent_roll: {
    tenants_in_place: Tenant[];
  };
  debt: {
    acquisition_loan: {
      enabled: boolean;
      ltv_max: number;
      amort_years: number;
      io_months: number;
      term_months: number;
      origination_fee_pct: number;
      rate: {
        type: string;
        fixed_rate: number;
      };
    };
  };
  exit: {
    exit_month: number;
    exit_cap_rate: number;
    sale_cost_pct: number;
    forward_noi_months: number;
  };
}

export interface ValidationResult {
  status: "ok" | "invalid";
  errors?: { path: string; message: string }[];
}

export interface BuildResult {
  status: "started" | "failed";
  job_id?: string;
  error?: string;
}

export interface JobStatus {
  status: "pending" | "running" | "complete" | "failed";
  job_id: string;
  outputs?: Record<string, unknown>;
  file_path?: string;
  download_url?: string;
  download_url_expiry?: string;
  error?: string;
}

export type RunState =
  | { phase: "idle" }
  | { phase: "validating" }
  | { phase: "building" }
  | { phase: "polling"; job_id: string }
  | { phase: "complete"; job_id: string; outputs: Record<string, unknown>; file_path: string | null; download_url: string | null; download_url_expiry: string | null }
  | { phase: "failed"; error: string };

export interface MissingField {
  path: string;
  description: string;
  example?: string;
}

export interface ExtractionResult {
  status: "extracted" | "needs_info" | "error";
  inputs?: Partial<IndAcqInputs>;
  missing_fields?: MissingField[];
  follow_up_question?: string;
  error?: string;
}
