import { describe, it, expect } from "vitest";
import { ExitModule } from "../../src/modules/exit/exit-module";
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

function runPriorModules(context: DealContext): void {
  const leaseModule = new LeaseModule();
  const operatingModule = new OperatingModule();
  const debtModule = new DebtModule();

  leaseModule.compute(context);
  operatingModule.compute(context);
  debtModule.compute(context);
}

describe("ExitModule", () => {
  const module = new ExitModule();

  describe("validation", () => {
    it("validates valid inputs", () => {
      const result = module.validate({
        exit_cap_rate: 0.0675,
        exit_month: 60,
        sale_cost_pct: 0.02,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid exit_cap_rate", () => {
      const result = module.validate({
        exit_cap_rate: 0,
        exit_month: 60,
        sale_cost_pct: 0.02,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toContain("exit_cap_rate");
    });

    it("rejects negative exit_month", () => {
      const result = module.validate({
        exit_cap_rate: 0.07,
        exit_month: -1,
        sale_cost_pct: 0.02,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toContain("exit_month");
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
              lease_end: "2032-12-31", // Extended to cover full hold period
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
      expect(result.errors).toContain("OperatingModule must be computed before ExitModule");
    });

    it("calculates sale price from cap rate", () => {
      const context = createTestContext(baseInputs);
      runPriorModules(context);
      const result = module.compute(context);

      expect(result.success).toBe(true);

      const outputs = context.outputs.exit as {
        forwardNoi: number;
        grossSalePrice: number;
      };

      // Sale price = Forward NOI / Exit Cap
      const expectedPrice = outputs.forwardNoi / 0.0675;
      expect(outputs.grossSalePrice).toBeCloseTo(expectedPrice, 0);
    });

    it("calculates sale costs", () => {
      const context = createTestContext(baseInputs);
      runPriorModules(context);
      module.compute(context);

      const outputs = context.outputs.exit as {
        grossSalePrice: number;
        saleCosts: number;
        netSaleProceeds: number;
      };

      // Sale costs = 2% of gross
      expect(outputs.saleCosts).toBeCloseTo(outputs.grossSalePrice * 0.02, 0);
      expect(outputs.netSaleProceeds).toBeCloseTo(
        outputs.grossSalePrice - outputs.saleCosts,
        0
      );
    });

    it("calculates loan payoff", () => {
      const context = createTestContext(baseInputs);
      runPriorModules(context);
      module.compute(context);

      const outputs = context.outputs.exit as {
        loanPayoff: number;
        netEquityProceeds: number;
        netSaleProceeds: number;
      };

      // Loan payoff should be positive (there's a loan)
      expect(outputs.loanPayoff).toBeGreaterThan(0);

      // Net equity = Net proceeds - loan payoff
      expect(outputs.netEquityProceeds).toBeCloseTo(
        outputs.netSaleProceeds - outputs.loanPayoff,
        0
      );
    });

    it("calculates IRRs", () => {
      const context = createTestContext(baseInputs);
      runPriorModules(context);
      module.compute(context);

      const outputs = context.outputs.exit as {
        unleveredIrr: number;
        leveredIrr: number;
      };

      // IRRs should be reasonable (between -50% and 100%)
      expect(outputs.unleveredIrr).toBeGreaterThan(-0.5);
      expect(outputs.unleveredIrr).toBeLessThan(1);

      expect(outputs.leveredIrr).toBeGreaterThan(-0.5);
      expect(outputs.leveredIrr).toBeLessThan(1);

      // Leverage should amplify returns (levered > unlevered for positive returns)
      // This may not always hold true depending on the deal
    });

    it("calculates equity multiple", () => {
      const context = createTestContext(baseInputs);
      runPriorModules(context);
      module.compute(context);

      const outputs = context.outputs.exit as { equityMultiple: number };

      // Equity multiple should be > 1 for a profitable deal
      expect(outputs.equityMultiple).toBeGreaterThan(1);
      expect(context.metrics.equityMultiple).toBe(outputs.equityMultiple);
    });

    it("updates context metrics", () => {
      const context = createTestContext(baseInputs);
      runPriorModules(context);
      module.compute(context);

      // All metrics should be set
      expect(context.metrics.unleveredIrr).toBeDefined();
      expect(context.metrics.leveredIrr).toBeDefined();
      expect(context.metrics.equityMultiple).toBeDefined();
      expect(context.metrics.goingInCapRate).toBeDefined();
      expect(context.metrics.exitCapRate).toBe(0.0675);
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
      runPriorModules(context);
      const result = module.compute(context);

      expect(result.success).toBe(true);

      const outputs = context.outputs.exit as {
        loanPayoff: number;
        unleveredIrr: number;
        leveredIrr: number;
      };

      // No debt means no loan payoff
      expect(outputs.loanPayoff).toBe(0);

      // Unlevered and levered should be the same
      expect(outputs.unleveredIrr).toBeCloseTo(outputs.leveredIrr, 4);
    });
  });
});
