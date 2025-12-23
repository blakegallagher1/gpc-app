import { describe, it, expect } from "vitest";
import { DealEngine, createSummaryReport } from "../../src/engine/deal-engine";
import { DealEngineInputs } from "../../src/types/inputs";

describe("DealEngine", () => {
  const engine = new DealEngine();

  const validInputs: DealEngineInputs = {
    contract: { contract_version: "DEAL_ENGINE_V0", engine_version: "0.1.0" },
    deal: {
      project_name: "FedEx Dallas Industrial",
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
            lease_end: "2032-12-31",
            current_rent_psf_annual: 8.75,
            annual_bump_pct: 0.03,
            lease_type: "NNN",
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

  describe("validateAll", () => {
    it("validates valid inputs", () => {
      const result = engine.validateAll(validInputs);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects missing deal", () => {
      const invalidInputs = { ...validInputs, deal: undefined } as unknown as DealEngineInputs;
      const result = engine.validateAll(invalidInputs);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === "deal")).toBe(true);
    });

    it("rejects missing acquisition", () => {
      const invalidInputs = {
        ...validInputs,
        modules: { ...validInputs.modules, acquisition: undefined },
      } as unknown as DealEngineInputs;
      const result = engine.validateAll(invalidInputs);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path.includes("acquisition"))).toBe(true);
    });
  });

  describe("run", () => {
    it("runs full deal analysis successfully", async () => {
      const result = await engine.run(validInputs);

      expect(result.success).toBe(true);
      expect(result.context).toBeDefined();
      expect(result.errors).toBeUndefined();
    });

    it("produces expected metrics", async () => {
      const result = await engine.run(validInputs);

      expect(result.success).toBe(true);
      const metrics = result.context!.metrics;

      // Check that all key metrics are calculated
      expect(metrics.noiYear1).toBeDefined();
      expect(metrics.noiYear1).toBeGreaterThan(0);

      expect(metrics.goingInCapRate).toBeDefined();
      expect(metrics.goingInCapRate).toBeGreaterThan(0);
      expect(metrics.goingInCapRate).toBeLessThan(0.15); // Reasonable cap rate

      expect(metrics.unleveredIrr).toBeDefined();
      expect(metrics.leveredIrr).toBeDefined();
      expect(metrics.equityMultiple).toBeDefined();
      expect(metrics.averageDscr).toBeDefined();
    });

    it("produces cashflow series of correct length", async () => {
      const result = await engine.run(validInputs);

      expect(result.success).toBe(true);
      const cashflows = result.context!.cashflows;

      expect(cashflows.revenue.length).toBe(60);
      expect(cashflows.noi.length).toBe(60);
      expect(cashflows.debtService.length).toBe(60);
      expect(cashflows.cashFlow.length).toBe(60);
    });

    it("handles no debt scenario", async () => {
      const inputsNoDebt = {
        ...validInputs,
        modules: {
          ...validInputs.modules,
          debt: undefined,
        },
      };

      const result = await engine.run(inputsNoDebt);

      expect(result.success).toBe(true);
      expect(result.context!.metrics.averageDscr).toBe(999); // No debt means "infinite" DSCR
    });

    it("returns validation errors for invalid inputs", async () => {
      const invalidInputs = {
        ...validInputs,
        deal: { ...validInputs.deal, hold_period_months: -1 },
      };

      const result = await engine.run(invalidInputs);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it("generates warnings for risky deals", async () => {
      // Create a deal with low DSCR by using high debt
      const riskyInputs = {
        ...validInputs,
        modules: {
          ...validInputs.modules,
          debt: {
            acquisition_loan: {
              ltv_max: 0.9, // Very high LTV
              rate: 0.08, // High rate
              amort_years: 20,
              io_months: 0,
              term_months: 60,
            },
          },
        },
      };

      const result = await engine.run(riskyInputs);

      expect(result.success).toBe(true);
      // Should have warning about low DSCR
      expect(result.warnings.some((w) => w.includes("DSCR"))).toBe(true);
    });
  });

  describe("createSummaryReport", () => {
    it("generates report for successful run", async () => {
      const result = await engine.run(validInputs);
      const report = createSummaryReport(result);

      expect(report).toContain("FedEx Dallas Industrial");
      expect(report).toContain("Dallas, TX");
      expect(report).toContain("Levered IRR");
      expect(report).toContain("Equity Multiple");
    });

    it("generates error report for failed run", async () => {
      const invalidInputs = {
        ...validInputs,
        deal: { ...validInputs.deal, hold_period_months: -1 },
      };

      const result = await engine.run(invalidInputs);
      const report = createSummaryReport(result);

      expect(report).toContain("Failed");
    });
  });
});
