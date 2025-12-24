import { pmt } from "../core/math-utils.js";
import { Series } from "../core/series.js";
import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type LoanRate =
  | { type: "fixed"; rate: number }
  | { type: "floating"; index?: string; spread?: number; rate?: number };

type LoanSizing = {
  method: "ltv_dscr" | "dscr_only" | "ltv_only";
  ltv_max?: number;
  dscr_min?: number;
};

type LoanInput = {
  loan_id: string;
  enabled: boolean;
  loan_type: string;
  principal_mode: "explicit" | "sized";
  principal_amount?: number;
  sizing?: LoanSizing;
  rate: LoanRate;
  amort_years?: number;
  io_months?: number;
  term_months: number;
  origination_fee_pct?: number;
};

type DebtEventInput = {
  type: "origination" | "refinance" | "payoff";
  month: number;
  loan_id: string;
  payoff_loan_id?: string;
  distribute_cash_out?: boolean;
};

type DebtInput = {
  loans: LoanInput[];
  events?: DebtEventInput[];
};

type DealEngineRequestShape = {
  acquisition?: {
    purchase_price?: number;
  };
  modules?: {
    debt?: DebtInput;
  };
};

export class DebtModule implements DealModule {
  name = "debt";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const debt = (request as DealEngineRequestShape).modules?.debt;
    if (!debt) {
      return;
    }

    const totalMonths = ctx.timeline.totalMonths;
    const debtService = new Array<number>(totalMonths).fill(0);
    const loanBalance = new Array<number>(totalMonths).fill(0);

    const events = debt.events ?? [];
    const loanStartMonth = this.buildLoanStartMap(events);
    const loanEndMonth = this.buildLoanEndMap(events, debt.loans);

    let totalLoanAmount = 0;
    let totalOriginationFees = 0;

    for (const loan of debt.loans) {
      if (!loan.enabled) {
        continue;
      }

      const startMonth = loanStartMonth.get(loan.loan_id) ?? 0;
      const endMonth = loanEndMonth.get(loan.loan_id) ?? loan.term_months;
      const loanAmount = this.sizeLoan(ctx, request, loan);
      totalLoanAmount += loanAmount;

      const originationFeePct = loan.origination_fee_pct ?? 0;
      totalOriginationFees += loanAmount * originationFeePct;

      const schedule = this.buildAmortizationSchedule(loan, loanAmount, startMonth, endMonth, totalMonths);

      for (let month = 0; month < totalMonths; month += 1) {
        debtService[month] += schedule.debtService[month] ?? 0;
        loanBalance[month] += schedule.balance[month] ?? 0;
      }
    }

    if (events.some((event) => event.distribute_cash_out)) {
      ctx.addWarning("Debt events cash-out not implemented in v0");
    }

    ctx.setSeries("debt_service", new Series(debtService));
    ctx.setSeries("loan_balance", new Series(loanBalance));
    ctx.setMetric("loan_amount", totalLoanAmount);
    ctx.setMetric("origination_fee", totalOriginationFees);
    ctx.setMetric("debt_service_year1", debtService.slice(0, Math.min(12, totalMonths)).reduce((a, b) => a + b, 0));
  }

  private sizeLoan(ctx: DealContext, request: DealEngineRequestV0, loan: LoanInput): number {
    if (loan.principal_mode === "explicit") {
      return loan.principal_amount ?? 0;
    }

    const purchasePrice = (request as DealEngineRequestShape).acquisition?.purchase_price ?? 0;
    const sizing = loan.sizing;
    if (!sizing) {
      return 0;
    }

    let ltvBased = Number.POSITIVE_INFINITY;
    if (sizing.method === "ltv_only" || sizing.method === "ltv_dscr") {
      const ltvMax = sizing.ltv_max ?? 0;
      ltvBased = purchasePrice * ltvMax;
    }

    let dscrBased = Number.POSITIVE_INFINITY;
    if (sizing.method === "dscr_only" || sizing.method === "ltv_dscr") {
      const noiYear1 = ctx.getMetric("noi_year1") ?? 0;
      const dscrMin = sizing.dscr_min ?? 1;
      const annualDebtServiceFactor = this.annualDebtServiceFactor(loan);
      if (annualDebtServiceFactor > 0) {
        dscrBased = noiYear1 / (dscrMin * annualDebtServiceFactor);
      }
    }

    if (sizing.method === "ltv_only") {
      return Number.isFinite(ltvBased) ? ltvBased : 0;
    }

    if (sizing.method === "dscr_only") {
      return Number.isFinite(dscrBased) ? dscrBased : 0;
    }

    const sized = Math.min(ltvBased, dscrBased);
    return Number.isFinite(sized) ? sized : 0;
  }

  private annualDebtServiceFactor(loan: LoanInput): number {
    const monthlyRate = this.monthlyRate(loan);
    const amortMonths = (loan.amort_years ?? Math.ceil(loan.term_months / 12)) * 12;
    if (monthlyRate === 0) {
      return 12 / amortMonths;
    }
    const payment = Math.abs(pmt(monthlyRate, amortMonths, 1));
    return payment * 12;
  }

  private monthlyRate(loan: LoanInput): number {
    if (loan.rate.type === "fixed") {
      return (loan.rate.rate ?? 0) / 12;
    }
    if (loan.rate.type === "floating") {
      const spread = loan.rate.spread ?? 0;
      const rate = loan.rate.rate ?? 0;
      return (rate + spread) / 12;
    }
    return 0;
  }

  private buildAmortizationSchedule(
    loan: LoanInput,
    loanAmount: number,
    startMonth: number,
    endMonth: number,
    totalMonths: number,
  ): { debtService: number[]; balance: number[] } {
    const debtService = new Array<number>(totalMonths).fill(0);
    const balance = new Array<number>(totalMonths).fill(0);

    if (loanAmount <= 0) {
      return { debtService, balance };
    }

    const monthlyRate = this.monthlyRate(loan);
    const amortMonths = (loan.amort_years ?? Math.ceil(loan.term_months / 12)) * 12;
    const ioMonths = loan.io_months ?? 0;
    const payment = monthlyRate === 0 ? loanAmount / amortMonths : Math.abs(pmt(monthlyRate, amortMonths, loanAmount));

    let currentBalance = loanAmount;
    const effectiveEnd = Math.min(endMonth, totalMonths);

    for (let month = startMonth; month < effectiveEnd; month += 1) {
      const elapsed = month - startMonth;
      if (elapsed < 0) {
        continue;
      }

      const interest = currentBalance * monthlyRate;
      let principal = 0;
      let debtPayment = 0;

      if (elapsed < ioMonths) {
        debtPayment = interest;
      } else {
        debtPayment = payment;
        principal = Math.max(debtPayment - interest, 0);
      }

      currentBalance = Math.max(currentBalance - principal, 0);
      debtService[month] = debtPayment;
      balance[month] = currentBalance;
    }

    return { debtService, balance };
  }

  private buildLoanStartMap(events: DebtEventInput[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const event of events) {
      if (event.type === "origination" || event.type === "refinance") {
        map.set(event.loan_id, event.month);
      }
    }
    return map;
  }

  private buildLoanEndMap(events: DebtEventInput[], loans: LoanInput[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const loan of loans) {
      map.set(loan.loan_id, loan.term_months);
    }

    for (const event of events) {
      if (event.type === "refinance" && event.payoff_loan_id) {
        map.set(event.payoff_loan_id, event.month);
      }
      if (event.type === "payoff") {
        map.set(event.loan_id, event.month);
      }
    }
    return map;
  }
}
