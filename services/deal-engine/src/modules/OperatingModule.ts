import { Series } from "../core/series.js";
import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type OtherIncomeLine = {
  name: string;
  amount_annual?: number;
  amount_monthly?: number;
  growth_pct?: number;
};

type ExpenseLine = {
  name: string;
  amount_year1: number;
  growth_pct?: number;
  recoverable?: boolean;
};

type ReservesInput = {
  amount_year1: number;
  growth_pct: number;
  growth_mode: "annual_compound" | "flat";
};

type OperatingInput = {
  vacancy_pct: number;
  credit_loss_pct: number;
  inflation: {
    rent: number;
    expenses: number;
    taxes: number;
  };
  other_income?: OtherIncomeLine[];
  expenses: {
    management_fee_pct_egi?: number;
    fixed_annual: {
      taxes?: number;
      insurance?: number;
      cam?: number;
      utilities?: number;
      repairs_maintenance?: number;
      admin?: number;
      custom?: ExpenseLine[];
      reserves?: ReservesInput;
    };
  };
};

type DealEngineRequestShape = {
  modules?: {
    operating?: OperatingInput;
  };
};

export class OperatingModule implements DealModule {
  name = "operating";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const operating = (request as DealEngineRequestShape).modules?.operating;
    if (!operating) {
      return;
    }

    const totalMonths = ctx.timeline.totalMonths;
    const grossRent = ctx.getSeries("gross_potential_rent") ?? Series.zeros(totalMonths);

    const vacancyLoss = grossRent.multiply(operating.vacancy_pct ?? 0);
    const creditLoss = grossRent.subtract(vacancyLoss).multiply(operating.credit_loss_pct ?? 0);

    const otherIncome = this.buildOtherIncomeSeries(operating.other_income ?? [], totalMonths);

    const egi = grossRent.subtract(vacancyLoss).subtract(creditLoss).add(otherIncome);
    ctx.setSeries("egi", egi);

    const managementFeePct = operating.expenses.management_fee_pct_egi ?? 0;
    const managementFee = egi.multiply(managementFeePct);

    const fixedAnnual = operating.expenses.fixed_annual;
    const expenseSeries: Series[] = [managementFee];

    expenseSeries.push(this.fixedAnnualSeries(fixedAnnual.taxes ?? 0, operating.inflation.taxes, totalMonths));
    expenseSeries.push(this.fixedAnnualSeries(fixedAnnual.insurance ?? 0, operating.inflation.expenses, totalMonths));
    expenseSeries.push(this.fixedAnnualSeries(fixedAnnual.cam ?? 0, operating.inflation.expenses, totalMonths));
    expenseSeries.push(this.fixedAnnualSeries(fixedAnnual.utilities ?? 0, operating.inflation.expenses, totalMonths));
    expenseSeries.push(this.fixedAnnualSeries(fixedAnnual.repairs_maintenance ?? 0, operating.inflation.expenses, totalMonths));
    expenseSeries.push(this.fixedAnnualSeries(fixedAnnual.admin ?? 0, operating.inflation.expenses, totalMonths));

    const customLines = fixedAnnual.custom ?? [];
    for (const line of customLines) {
      const growth = line.growth_pct ?? operating.inflation.expenses;
      expenseSeries.push(this.fixedAnnualSeries(line.amount_year1, growth, totalMonths));
    }

    const reserves = fixedAnnual.reserves;
    if (reserves) {
      const growth = reserves.growth_mode === "annual_compound" ? reserves.growth_pct : 0;
      expenseSeries.push(this.fixedAnnualSeries(reserves.amount_year1, growth, totalMonths));
    }

    let totalOpex = Series.zeros(totalMonths);
    for (const series of expenseSeries) {
      totalOpex = totalOpex.add(series);
    }

    const noi = egi.subtract(totalOpex);

    ctx.setSeries("total_opex", totalOpex);
    ctx.setSeries("noi", noi);
    ctx.setMetric("noi_year1", noi.sumRange(0, Math.min(12, totalMonths)));
  }

  private fixedAnnualSeries(amountYear1: number, growthPct: number, totalMonths: number): Series {
    const values = new Array<number>(totalMonths).fill(0);
    for (let month = 0; month < totalMonths; month += 1) {
      const yearIndex = Math.floor(month / 12);
      const annual = amountYear1 * Math.pow(1 + growthPct, yearIndex);
      values[month] = annual / 12;
    }
    return new Series(values);
  }

  private buildOtherIncomeSeries(lines: OtherIncomeLine[], totalMonths: number): Series {
    const values = new Array<number>(totalMonths).fill(0);
    for (const line of lines) {
      const annualBase = line.amount_annual ?? (line.amount_monthly ?? 0) * 12;
      const growth = line.growth_pct ?? 0;
      for (let month = 0; month < totalMonths; month += 1) {
        const yearIndex = Math.floor(month / 12);
        const annual = annualBase * Math.pow(1 + growth, yearIndex);
        values[month] += annual / 12;
      }
    }
    return new Series(values);
  }
}
