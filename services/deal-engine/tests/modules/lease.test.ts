import { describe, it, expect } from "vitest";
import { LeaseModule } from "../../src/modules/lease/lease-module";
import { Timeline } from "../../src/core/timeline";
import { Series } from "../../src/core/series";
import { DealContext } from "../../src/types/context";
import { DealEngineInputs } from "../../src/types/inputs";

function createTestContext(inputs: DealEngineInputs): DealContext {
  const timeline = new Timeline({
    startDate: inputs.deal.analysis_start_date,
    holdPeriodMonths: inputs.deal.hold_period_months,
  });

  return {
    timeline,
    inputs,
    outputs: {},
    cashflows: {
      revenue: Series.zeros(timeline.totalMonths),
      expenses: Series.zeros(timeline.totalMonths),
      noi: Series.zeros(timeline.totalMonths),
      debtService: Series.zeros(timeline.totalMonths),
      cashFlow: Series.zeros(timeline.totalMonths),
    },
    metrics: {},
    warnings: [],
  };
}

describe("LeaseModule", () => {
  const module = new LeaseModule();

  describe("validation", () => {
    it("validates valid inputs", () => {
      const result = module.validate({
        tenants_in_place: [
          {
            tenant_name: "FedEx",
            sf: 75000,
            lease_start: "2024-01-01",
            lease_end: "2029-12-31",
            current_rent_psf_annual: 8.75,
            annual_bump_pct: 0.03,
          },
        ],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects missing tenant_name", () => {
      const result = module.validate({
        tenants_in_place: [
          {
            tenant_name: "",
            sf: 75000,
            lease_start: "2024-01-01",
            lease_end: "2029-12-31",
            current_rent_psf_annual: 8.75,
          },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toContain("tenant_name");
    });

    it("rejects invalid sf", () => {
      const result = module.validate({
        tenants_in_place: [
          {
            tenant_name: "FedEx",
            sf: -1000,
            lease_start: "2024-01-01",
            lease_end: "2029-12-31",
            current_rent_psf_annual: 8.75,
          },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toContain("sf");
    });
  });

  describe("compute", () => {
    it("calculates rent schedule for single tenant", () => {
      const inputs: DealEngineInputs = {
        contract: { contract_version: "DEAL_ENGINE_V0", engine_version: "0.1.0" },
        deal: {
          project_name: "FedEx Dallas",
          city: "Dallas",
          state: "TX",
          analysis_start_date: "2026-01-01",
          hold_period_months: 60,
          gross_sf: 75000,
          net_sf: 75000,
        },
        modules: {
          acquisition: { purchase_price: 8500000, closing_cost_pct: 0.02 },
          lease: {
            tenants_in_place: [
              {
                tenant_name: "FedEx",
                sf: 75000,
                lease_start: "2024-01-01",
                lease_end: "2029-12-31",
                current_rent_psf_annual: 8.75,
                annual_bump_pct: 0.03,
              },
            ],
          },
          exit: { exit_cap_rate: 0.0675, exit_month: 60, sale_cost_pct: 0.02 },
        },
      };

      const context = createTestContext(inputs);
      const result = module.compute(context);

      expect(result.success).toBe(true);
      expect(context.outputs.lease).toBeDefined();

      const leaseOutputs = context.outputs.lease as {
        grossPotentialRent: Series;
        tenantSchedules: Array<{ tenantName: string; sf: number }>;
      };

      // Check tenant schedule was created
      expect(leaseOutputs.tenantSchedules).toHaveLength(1);
      expect(leaseOutputs.tenantSchedules[0].tenantName).toBe("FedEx");

      // Check gross potential rent
      const gpr = leaseOutputs.grossPotentialRent;
      expect(gpr.length).toBe(60);

      // First month rent: 8.75 * 75000 / 12 = 54,687.50
      // But lease started in 2024, so by 2026 we're in year 3 of bumps
      // Year 1 (2024): base * 1.03^0 = base
      // Year 2 (2025): base * 1.03^1
      // Year 3 (2026): base * 1.03^2
      const baseMonthly = (8.75 * 75000) / 12;
      const expectedMonth0 = baseMonthly * Math.pow(1.03, 2);
      expect(gpr.get(0)).toBeCloseTo(expectedMonth0, 0);
    });

    it("handles free rent months", () => {
      const inputs: DealEngineInputs = {
        contract: { contract_version: "DEAL_ENGINE_V0", engine_version: "0.1.0" },
        deal: {
          project_name: "Test Deal",
          city: "Houston",
          state: "TX",
          analysis_start_date: "2026-01-01",
          hold_period_months: 24,
          gross_sf: 50000,
          net_sf: 50000,
        },
        modules: {
          acquisition: { purchase_price: 5000000, closing_cost_pct: 0.02 },
          lease: {
            tenants_in_place: [
              {
                tenant_name: "Tenant A",
                sf: 50000,
                lease_start: "2026-01-01",
                lease_end: "2031-01-01",
                current_rent_psf_annual: 10.0,
                free_rent_months: 3,
              },
            ],
          },
          exit: { exit_cap_rate: 0.07, exit_month: 24, sale_cost_pct: 0.02 },
        },
      };

      const context = createTestContext(inputs);
      const result = module.compute(context);

      expect(result.success).toBe(true);

      const leaseOutputs = context.outputs.lease as {
        grossPotentialRent: Series;
        freeRentAbatement: Series;
        effectiveGrossRevenue: Series;
      };

      // First 3 months should have free rent abatement
      const monthlyRent = (10.0 * 50000) / 12;
      expect(leaseOutputs.freeRentAbatement.get(0)).toBeCloseTo(monthlyRent, 0);
      expect(leaseOutputs.freeRentAbatement.get(2)).toBeCloseTo(monthlyRent, 0);
      expect(leaseOutputs.freeRentAbatement.get(3)).toBe(0);

      // Effective gross revenue in month 0 should be 0 due to free rent
      expect(leaseOutputs.effectiveGrossRevenue.get(0)).toBe(0);
      // Month 4 should have full rent
      expect(leaseOutputs.effectiveGrossRevenue.get(3)).toBeCloseTo(monthlyRent, 0);
    });

    it("calculates TI and LC costs", () => {
      const inputs: DealEngineInputs = {
        contract: { contract_version: "DEAL_ENGINE_V0", engine_version: "0.1.0" },
        deal: {
          project_name: "TI/LC Test",
          city: "Austin",
          state: "TX",
          analysis_start_date: "2026-01-01",
          hold_period_months: 36,
          gross_sf: 25000,
          net_sf: 25000,
        },
        modules: {
          acquisition: { purchase_price: 3000000, closing_cost_pct: 0.02 },
          lease: {
            tenants_in_place: [
              {
                tenant_name: "Tenant TI",
                sf: 25000,
                lease_start: "2026-01-01",
                lease_end: "2031-01-01",
                current_rent_psf_annual: 12.0,
                ti: { mode: "PER_SF", value: 15 },
                lc: { mode: "PER_SF", value: 2 },
              },
            ],
          },
          exit: { exit_cap_rate: 0.065, exit_month: 36, sale_cost_pct: 0.02 },
        },
      };

      const context = createTestContext(inputs);
      const result = module.compute(context);

      expect(result.success).toBe(true);

      const leaseOutputs = context.outputs.lease as {
        totalTiCost: number;
        totalLcCost: number;
      };

      // TI: $15/SF * 25000 SF = $375,000
      expect(leaseOutputs.totalTiCost).toBe(375000);
      // LC: $2/SF * 25000 SF = $50,000
      expect(leaseOutputs.totalLcCost).toBe(50000);
    });
  });
});
