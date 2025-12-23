/**
 * Deal Engine Demo Script
 *
 * Run with: npx tsx demo/run-demo.ts
 */

import { DealEngine, createSummaryReport } from "../src";
import { DealEngineInputs } from "../src/types/inputs";

const fedexDallasInputs: DealEngineInputs = {
  contract: {
    contract_version: "DEAL_ENGINE_V0",
    engine_version: "0.1.0",
  },
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
    acquisition: {
      purchase_price: 8500000,
      closing_cost_pct: 0.02,
    },
    lease: {
      tenants_in_place: [
        {
          tenant_name: "FedEx Ground",
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
      inflation: {
        rent: 0.03,
        expenses: 0.025,
        taxes: 0.02,
      },
      expenses: {
        recoveries: {
          mode: "NNN",
        },
      },
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
    exit: {
      exit_cap_rate: 0.0675,
      exit_month: 60,
      sale_cost_pct: 0.02,
    },
  },
};

async function main() {
  console.log("Deal Engine Demo");
  console.log("================\n");

  const engine = new DealEngine();

  // Run the deal
  console.log("Running deal analysis...\n");
  const result = await engine.run(fedexDallasInputs);

  if (!result.success) {
    console.error("Deal analysis failed:");
    result.errors?.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  // Print summary report
  const report = createSummaryReport(result);
  console.log(report);

  // Print detailed cashflow data
  console.log("\nANNUAL CASHFLOW SUMMARY");
  console.log("-".repeat(60));

  const ctx = result.context!;
  const noiAnnual = ctx.cashflows.noi.annualize();
  const dsAnnual = ctx.cashflows.debtService.annualize();

  for (let year = 0; year < noiAnnual.length; year++) {
    const noi = noiAnnual[year];
    const ds = dsAnnual[year];
    const cf = noi - ds;
    console.log(
      `Year ${year + 1}: NOI $${noi.toLocaleString(undefined, { maximumFractionDigits: 0 })} | DS $${ds.toLocaleString(undefined, { maximumFractionDigits: 0 })} | CF $${cf.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    );
  }
}

main().catch(console.error);
