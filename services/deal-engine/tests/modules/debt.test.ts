import { describe, it, expect } from "vitest";
import { DebtModule } from "../../src/modules/debt/debt-module";
import { OperatingModule } from "../../src/modules/operating/operating-module";
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

describe("DebtModule", () => {
  const leaseModule = new LeaseModule();
  const operatingModule = new OperatingModule();
  const module = new DebtModule();

  describe("validation", () => {
    it("validates valid inputs", () => {
      const result = module.validate({
        acquisition_loan: {
          ltv_max: 0.7,
          rate: 0.06,
          amort_years: 25,
          io_months: 12,
          term_months: 60,
        },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts undefined inputs (no debt)", () => {
      const result = module.validate(undefined);
      expect(result.valid).toBe(true);
    });

    it("rejects invalid LTV", () => {
      const result = module.validate({
        acquisition_loan: {
          ltv_max: 1.5,
          rate: 0.06,
          amort_years: 25,
          io_months: 12,
          term_months: 60,
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toContain("ltv_max");
    });
  });

  describe("compute", () => {
    const baseInputs: DealEngineInputs = {
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
        operating: {
          vacancy_pct: 0.05,
          credit_loss_pct: 0.01,
          inflation: { rent: 0.03, expenses: 0.025, taxes: 0.02 },
          expenses: { recoveries: { mode: "NNN" } },
        },
        debt: {
          acquisition_loan: {
            ltv_max: 0.7,
            rate: 0.06,
            amort_years: 25,
            io_months: 12,
            term_months: 60,
          },
        },
        exit: { exit_cap_rate: 0.0675, exit_month: 60, sale_cost_pct: 0.02 },
      },
    };

    it("requires OperatingModule to run first", () => {
      const context = createTestContext(baseInputs);
      const result = module.compute(context);

      expect(result.success).toBe(false);
      expect(result.errors).toContain("OperatingModule must be computed before DebtModule");
    });

    it("calculates loan amount from LTV", () => {
      const context = createTestContext(baseInputs);
      leaseModule.compute(context);
      operatingModule.compute(context);
      const result = module.compute(context);

      expect(result.success).toBe(true);

      const outputs = context.outputs.debt as { loanAmount: number };

      // Loan = 8,500,000 * 0.70 = 5,950,000
      expect(outputs.loanAmount).toBe(5950000);
    });

    it("handles interest-only period", () => {
      const context = createTestContext(baseInputs);
      leaseModule.compute(context);
      operatingModule.compute(context);
      module.compute(context);

      const outputs = context.outputs.debt as {
        interestPayment: Series;
        principalPayment: Series;
        loanBalance: Series;
      };

      // During IO period (first 12 months), principal should be 0
      expect(outputs.principalPayment.get(0)).toBe(0);
      expect(outputs.principalPayment.get(11)).toBe(0);

      // After IO period, principal should be positive
      expect(outputs.principalPayment.get(12)).toBeGreaterThan(0);

      // Balance should stay constant during IO
      expect(outputs.loanBalance.get(0)).toBeCloseTo(outputs.loanBalance.get(11), 0);
    });

    it("calculates DSCR", () => {
      const context = createTestContext(baseInputs);
      leaseModule.compute(context);
      operatingModule.compute(context);
      module.compute(context);

      const outputs = context.outputs.debt as { dscr: Series; averageDscr: number };

      // DSCR should be > 1 for a performing loan
      expect(outputs.averageDscr).toBeGreaterThan(1);
      expect(context.metrics.averageDscr).toBeGreaterThan(1);
    });

    it("handles no debt scenario", () => {
      const inputsNoDebt = {
        ...baseInputs,
        modules: {
          ...baseInputs.modules,
          debt: undefined,
        },
      };

      const context = createTestContext(inputsNoDebt);
      leaseModule.compute(context);
      operatingModule.compute(context);
      const result = module.compute(context);

      expect(result.success).toBe(true);

      const outputs = context.outputs.debt as {
        loanAmount: number;
        totalDebtService: Series;
      };

      expect(outputs.loanAmount).toBe(0);
      expect(outputs.totalDebtService.sum()).toBe(0);
    });
  });
});
