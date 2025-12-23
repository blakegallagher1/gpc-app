import { describe, it, expect } from "vitest";
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

describe("OperatingModule", () => {
  const leaseModule = new LeaseModule();
  const module = new OperatingModule();

  describe("validation", () => {
    it("validates valid inputs", () => {
      const result = module.validate({
        vacancy_pct: 0.05,
        credit_loss_pct: 0.01,
        inflation: { rent: 0.03, expenses: 0.03, taxes: 0.02 },
        expenses: { recoveries: { mode: "NNN" } },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts undefined inputs (uses defaults)", () => {
      const result = module.validate(undefined);
      expect(result.valid).toBe(true);
    });

    it("rejects invalid vacancy_pct", () => {
      const result = module.validate({
        vacancy_pct: 1.5,
        credit_loss_pct: 0.01,
        inflation: { rent: 0.03, expenses: 0.03, taxes: 0.02 },
        expenses: { recoveries: { mode: "NNN" } },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toContain("vacancy_pct");
    });
  });

  describe("compute", () => {
    const baseInputs: DealEngineInputs = {
      contract: { contract_version: "DEAL_ENGINE_V0", engine_version: "0.1.0" },
      deal: {
        project_name: "Test Property",
        city: "Dallas",
        state: "TX",
        analysis_start_date: "2026-01-01",
        hold_period_months: 60,
        gross_sf: 100000,
        net_sf: 100000,
      },
      modules: {
        acquisition: { purchase_price: 10000000, closing_cost_pct: 0.02 },
        lease: {
          tenants_in_place: [
            {
              tenant_name: "Amazon",
              sf: 100000,
              lease_start: "2025-01-01",
              lease_end: "2030-12-31",
              current_rent_psf_annual: 8.0,
            },
          ],
        },
        operating: {
          vacancy_pct: 0.05,
          credit_loss_pct: 0.01,
          inflation: { rent: 0.03, expenses: 0.025, taxes: 0.02 },
          expenses: { recoveries: { mode: "NNN" } },
        },
        exit: { exit_cap_rate: 0.07, exit_month: 60, sale_cost_pct: 0.02 },
      },
    };

    it("requires LeaseModule to run first", () => {
      const context = createTestContext(baseInputs);
      const result = module.compute(context);

      expect(result.success).toBe(false);
      expect(result.errors).toContain("LeaseModule must be computed before OperatingModule");
    });

    it("calculates vacancy loss", () => {
      const context = createTestContext(baseInputs);

      // Run lease module first
      leaseModule.compute(context);

      // Run operating module
      const result = module.compute(context);
      expect(result.success).toBe(true);

      const outputs = context.outputs.operating as {
        vacancyLoss: Series;
        effectiveGrossIncome: Series;
      };

      // Vacancy should be 5% of EGR
      const egr = context.cashflows.revenue;
      const expectedVacancy = egr.get(0) * 0.05;
      expect(outputs.vacancyLoss.get(0)).toBeCloseTo(expectedVacancy, 0);
    });

    it("calculates NOI with NNN recovery", () => {
      const context = createTestContext(baseInputs);
      leaseModule.compute(context);
      module.compute(context);

      const outputs = context.outputs.operating as {
        netOperatingIncome: Series;
        operatingExpenses: Series;
        expenseRecoveries: Series;
      };

      // With NNN, recoveries should equal expenses
      expect(outputs.expenseRecoveries.get(0)).toBeCloseTo(outputs.operatingExpenses.get(0), 0);

      // NOI should be EGI - expenses + recoveries
      expect(outputs.netOperatingIncome.length).toBe(60);
    });

    it("calculates NOI with Modified Gross (partial recovery)", () => {
      const inputs = {
        ...baseInputs,
        modules: {
          ...baseInputs.modules,
          operating: {
            ...baseInputs.modules.operating!,
            expenses: { recoveries: { mode: "MOD_GROSS" as const } },
          },
        },
      };

      const context = createTestContext(inputs);
      leaseModule.compute(context);
      module.compute(context);

      const outputs = context.outputs.operating as {
        operatingExpenses: Series;
        expenseRecoveries: Series;
      };

      // Modified Gross should recover 50% of expenses
      const expectedRecovery = outputs.operatingExpenses.get(0) * 0.5;
      expect(outputs.expenseRecoveries.get(0)).toBeCloseTo(expectedRecovery, 0);
    });

    it("calculates NOI with Gross (no recovery)", () => {
      const inputs = {
        ...baseInputs,
        modules: {
          ...baseInputs.modules,
          operating: {
            ...baseInputs.modules.operating!,
            expenses: { recoveries: { mode: "GROSS" as const } },
          },
        },
      };

      const context = createTestContext(inputs);
      leaseModule.compute(context);
      module.compute(context);

      const outputs = context.outputs.operating as {
        expenseRecoveries: Series;
      };

      // Gross lease should have zero recoveries
      expect(outputs.expenseRecoveries.get(0)).toBe(0);
      expect(outputs.expenseRecoveries.sum()).toBe(0);
    });

    it("updates context metrics with Year 1 NOI", () => {
      const context = createTestContext(baseInputs);
      leaseModule.compute(context);
      module.compute(context);

      expect(context.metrics.noiYear1).toBeDefined();
      expect(context.metrics.noiYear1).toBeGreaterThan(0);
    });
  });
});
