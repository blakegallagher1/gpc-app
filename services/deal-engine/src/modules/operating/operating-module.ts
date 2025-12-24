import { Series } from "../../core/series.js";
import { DealContext } from "../../types/context.js";
import { OperatingInput, ExpenseLineItem, GranularExpensesInput } from "../../types/inputs.js";
import { Module, ModuleResult, ValidationResult } from "../../types/module.js";
import { LeaseModuleOutputs } from "../lease/lease-module.js";

export interface GranularExpenseOutputs {
  realEstateTaxes: Series;
  insurance: Series;
  camRm: Series;
  utilities: Series;
  managementFee: Series;
  adminGeneral: Series;
  marketing: Series;
  payroll: Series;
  reserves: Series;
  other: Series;
}

export interface OperatingModuleOutputs {
  vacancyLoss: Series;
  creditLoss: Series;
  effectiveGrossIncome: Series;
  operatingExpenses: Series;
  expenseRecoveries: Series;
  netOperatingIncome: Series;
  // Granular expense breakdown
  granularExpenses?: GranularExpenseOutputs;
  // Key metrics
  opexRatio?: number;
  opexPsf?: number;
}

type OperatingModuleResult = ModuleResult<OperatingModuleOutputs>;

const DEFAULT_OPERATING: OperatingInput = {
  vacancy_pct: 0.05,
  credit_loss_pct: 0.01,
  inflation: {
    rent: 0.03,
    expenses: 0.03,
    taxes: 0.02,
    recoveries: 0.02,
  },
  expenses: {
    recoveries: {
      mode: "NNN",
      tax_recoverable: true,
      insurance_recoverable: true,
      cam_recoverable: true,
      admin_fee_pct: 0,
      caps: {
        cam_annual_increase_cap: 0,
      },
    },
  },
};

const EXPENSE_WEIGHTS = {
  taxes: 0.4,
  insurance: 0.1,
  cam: 0.5,
};

function assertOperatingInput(inputs: unknown): asserts inputs is OperatingInput | undefined {
  if (inputs === undefined) return;
  if (typeof inputs !== "object" || inputs === null) {
    throw new TypeError("operating must be an object");
  }
  const inp = inputs as Record<string, unknown>;
  if (typeof inp.vacancy_pct !== "number" && inp.vacancy_pct !== undefined) {
    throw new TypeError("vacancy_pct must be a number");
  }
}

export class OperatingModule implements Module<OperatingModuleOutputs> {
  readonly name = "operating";
  readonly version = "0.1.0";
  readonly dependencies: readonly string[] = ["lease"];

  validate(inputs: unknown): ValidationResult {
    const errors: { path: string; message: string }[] = [];

    try {
      assertOperatingInput(inputs);
    } catch (e) {
      errors.push({ path: "operating", message: (e as Error).message });
      return { valid: false, errors };
    }

    const operatingInputs = inputs as OperatingInput | undefined;

    if (operatingInputs) {
      if (operatingInputs.vacancy_pct < 0 || operatingInputs.vacancy_pct > 1) {
        errors.push({
          path: "operating.vacancy_pct",
          message: "vacancy_pct must be between 0 and 1",
        });
      }
      if (operatingInputs.credit_loss_pct < 0 || operatingInputs.credit_loss_pct > 1) {
        errors.push({
          path: "operating.credit_loss_pct",
          message: "credit_loss_pct must be between 0 and 1",
        });
      }
      if (
        operatingInputs.inflation.recoveries !== undefined &&
        (operatingInputs.inflation.recoveries < -0.1 || operatingInputs.inflation.recoveries > 0.2)
      ) {
        errors.push({
          path: "operating.inflation.recoveries",
          message: "recoveries must be between -0.1 and 0.2",
        });
      }
      const recoveries = operatingInputs.expenses.recoveries;
      if (recoveries.admin_fee_pct !== undefined && (recoveries.admin_fee_pct < 0 || recoveries.admin_fee_pct > 1)) {
        errors.push({
          path: "operating.expenses.recoveries.admin_fee_pct",
          message: "admin_fee_pct must be between 0 and 1",
        });
      }
      if (
        recoveries.caps?.cam_annual_increase_cap !== undefined &&
        (recoveries.caps.cam_annual_increase_cap < 0 || recoveries.caps.cam_annual_increase_cap > 1)
      ) {
        errors.push({
          path: "operating.expenses.recoveries.caps.cam_annual_increase_cap",
          message: "cam_annual_increase_cap must be between 0 and 1",
        });
      }
      if (operatingInputs.reserves_schedule) {
        operatingInputs.reserves_schedule.forEach((entry, idx) => {
          if (!Number.isInteger(entry.year)) {
            errors.push({
              path: `operating.reserves_schedule[${idx}].year`,
              message: "year must be an integer",
            });
          }
          if (entry.amount < 0) {
            errors.push({
              path: `operating.reserves_schedule[${idx}].amount`,
              message: "amount must be greater than or equal to 0",
            });
          }
        });
      }
      if (
        operatingInputs.expenses.fixed_annual?.reserves_growth_pct !== undefined &&
        (operatingInputs.expenses.fixed_annual.reserves_growth_pct < 0 ||
          operatingInputs.expenses.fixed_annual.reserves_growth_pct > 1)
      ) {
        errors.push({
          path: "operating.expenses.fixed_annual.reserves_growth_pct",
          message: "reserves_growth_pct must be between 0 and 1",
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  compute(context: DealContext): OperatingModuleResult {
    const operatingInputs = context.inputs.modules.operating ?? DEFAULT_OPERATING;
    const timeline = context.timeline;
    const totalMonths = timeline.totalMonths;
    const grossSf = context.inputs.deal.gross_sf;
    const netSf = context.inputs.deal.net_sf ?? grossSf;

    // Get lease outputs
    const leaseOutputs = context.outputs.lease as LeaseModuleOutputs;
    if (!leaseOutputs) {
      return {
        success: false,
        errors: ["LeaseModule must be computed before OperatingModule"],
      };
    }

    const effectiveGrossRevenue = leaseOutputs.effectiveGrossRevenue;

    // Apply vacancy loss
    const vacancyRate = operatingInputs.vacancy_pct;
    const vacancyLoss = effectiveGrossRevenue.multiply(vacancyRate);

    // Apply credit loss
    const creditLossRate = operatingInputs.credit_loss_pct;
    const revenueAfterVacancy = effectiveGrossRevenue.subtract(vacancyLoss);
    const creditLoss = revenueAfterVacancy.multiply(creditLossRate);

    // Calculate Effective Gross Income
    const effectiveGrossIncome = revenueAfterVacancy.subtract(creditLoss);

    const recoveriesConfig = operatingInputs.expenses.recoveries;
    const recoveryMode = recoveriesConfig.mode;
    const adminFeePct = recoveriesConfig.admin_fee_pct ?? 0;

    // Check if we have granular expenses
    const granular = operatingInputs.expenses.granular;
    let granularExpenses: GranularExpenseOutputs | undefined;
    let operatingExpenses: Series;
    let expenseRecoveries: Series;

    if (granular) {
      // Use granular expense model
      const result = this.computeGranularExpenses(
        granular,
        operatingInputs,
        effectiveGrossIncome,
        totalMonths,
        grossSf,
        recoveryMode,
        adminFeePct
      );
      granularExpenses = result.expenses;
      operatingExpenses = result.totalExpenses;
      expenseRecoveries = result.recoveries;
    } else {
      // Legacy simplified expense model
      const result = this.computeLegacyExpenses(
        operatingInputs,
        totalMonths,
        grossSf,
        timeline,
        recoveriesConfig,
        adminFeePct,
        recoveryMode
      );
      operatingExpenses = result.totalExpenses;
      expenseRecoveries = result.recoveries;
    }

    // Calculate NOI
    const netOperatingIncome = effectiveGrossIncome
      .subtract(operatingExpenses)
      .add(expenseRecoveries);

    // Calculate key metrics
    const year1Egi = effectiveGrossIncome.forward12(0);
    const year1Opex = operatingExpenses.forward12(0);
    const opexRatio = year1Egi > 0 ? year1Opex / year1Egi : 0;
    const opexPsf = netSf > 0 ? year1Opex / netSf : 0;

    const outputs: OperatingModuleOutputs = {
      vacancyLoss,
      creditLoss,
      effectiveGrossIncome,
      operatingExpenses,
      expenseRecoveries,
      netOperatingIncome,
      granularExpenses,
      opexRatio,
      opexPsf,
    };

    // Update context
    context.outputs.operating = outputs;
    context.cashflows.expenses = operatingExpenses.subtract(expenseRecoveries);
    context.cashflows.noi = netOperatingIncome;

    // Store granular series for annual cash flow in outputs
    if (granularExpenses) {
      context.outputs.expense_real_estate_taxes = granularExpenses.realEstateTaxes;
      context.outputs.expense_insurance = granularExpenses.insurance;
      context.outputs.expense_cam_rm = granularExpenses.camRm;
      context.outputs.expense_utilities = granularExpenses.utilities;
      context.outputs.expense_management = granularExpenses.managementFee;
      context.outputs.expense_admin = granularExpenses.adminGeneral;
      context.outputs.expense_reserves = granularExpenses.reserves;
    }

    // Calculate Year 1 NOI for metrics
    context.metrics.noiYear1 = netOperatingIncome.forward12(0);

    return { success: true, outputs };
  }

  private computeGranularExpenses(
    granular: GranularExpensesInput,
    operatingInputs: OperatingInput,
    egi: Series,
    totalMonths: number,
    grossSf: number,
    recoveryMode: string,
    adminFeePct: number
  ): { expenses: GranularExpenseOutputs; totalExpenses: Series; recoveries: Series } {
    const taxInflation = operatingInputs.inflation.taxes;
    const expenseInflation = operatingInputs.inflation.expenses;

    // Helper to generate monthly series from expense line item
    const generateSeries = (item: ExpenseLineItem | undefined, inflationRate: number): Series => {
      if (!item || item.amount_year1 <= 0) return Series.zeros(totalMonths);
      const growth = item.growth_pct ?? inflationRate;
      const monthlyBase = item.amount_year1 / 12;
      const values = new Array(totalMonths).fill(0);
      for (let m = 0; m < totalMonths; m++) {
        const yearIndex = Math.floor(m / 12);
        values[m] = monthlyBase * Math.pow(1 + growth, yearIndex);
      }
      return new Series(values);
    };

    // Generate each expense line
    const realEstateTaxes = generateSeries(granular.real_estate_taxes, taxInflation);
    const insurance = generateSeries(granular.insurance, expenseInflation);
    const camRm = generateSeries(granular.cam_rm, expenseInflation);
    const utilities = generateSeries(granular.utilities, expenseInflation);
    const adminGeneral = generateSeries(granular.admin_general, expenseInflation);
    const marketing = generateSeries(granular.marketing, expenseInflation);
    const payroll = generateSeries(granular.payroll, expenseInflation);
    const reserves = generateSeries(granular.reserves, expenseInflation);

    // Management fee - can be % of EGI or fixed
    let managementFee: Series;
    if (granular.management_fee && "pct_of_egi" in granular.management_fee) {
      const pct = granular.management_fee.pct_of_egi;
      managementFee = egi.multiply(pct);
    } else {
      managementFee = generateSeries(granular.management_fee as ExpenseLineItem | undefined, expenseInflation);
    }

    // Other expenses
    let other = Series.zeros(totalMonths);
    if (granular.other && granular.other.length > 0) {
      for (const item of granular.other) {
        other = other.add(generateSeries(item, expenseInflation));
      }
    }

    // Total operating expenses
    const totalExpenses = realEstateTaxes
      .add(insurance)
      .add(camRm)
      .add(utilities)
      .add(managementFee)
      .add(adminGeneral)
      .add(marketing)
      .add(payroll)
      .add(reserves)
      .add(other);

    // Calculate recoveries based on lease type
    let recoveries: Series;
    const taxRecoverable = granular.real_estate_taxes?.recoverable ?? true;
    const insuranceRecoverable = granular.insurance?.recoverable ?? true;
    const camRecoverable = granular.cam_rm?.recoverable ?? true;

    if (recoveryMode === "NNN") {
      // NNN: Full recovery of recoverable expenses
      let recoverableTotal = Series.zeros(totalMonths);
      if (taxRecoverable) recoverableTotal = recoverableTotal.add(realEstateTaxes);
      if (insuranceRecoverable) recoverableTotal = recoverableTotal.add(insurance);
      if (camRecoverable) recoverableTotal = recoverableTotal.add(camRm);
      recoveries = recoverableTotal.multiply(1 + adminFeePct);
    } else if (recoveryMode === "MOD_GROSS") {
      // Modified Gross: 50% of recoverable expenses
      let recoverableTotal = Series.zeros(totalMonths);
      if (taxRecoverable) recoverableTotal = recoverableTotal.add(realEstateTaxes);
      if (insuranceRecoverable) recoverableTotal = recoverableTotal.add(insurance);
      if (camRecoverable) recoverableTotal = recoverableTotal.add(camRm);
      recoveries = recoverableTotal.multiply(0.5 * (1 + adminFeePct));
    } else {
      // GROSS: No recoveries
      recoveries = Series.zeros(totalMonths);
    }

    return {
      expenses: {
        realEstateTaxes,
        insurance,
        camRm,
        utilities,
        managementFee,
        adminGeneral,
        marketing,
        payroll,
        reserves,
        other,
      },
      totalExpenses,
      recoveries,
    };
  }

  private computeLegacyExpenses(
    operatingInputs: OperatingInput,
    totalMonths: number,
    grossSf: number,
    timeline: { dateAt: (m: number) => { year: number } },
    recoveriesConfig: OperatingInput["expenses"]["recoveries"],
    adminFeePct: number,
    recoveryMode: string
  ): { totalExpenses: Series; recoveries: Series } {
    // Legacy simplified expense model (backwards compatible)
    const baseExpensePerSf = 3.0;
    const monthlyBaseExpense = (baseExpensePerSf * grossSf) / 12;
    const expenseInflation = operatingInputs.inflation.expenses;
    const taxInflation = operatingInputs.inflation.taxes;
    const recoveriesInflation = operatingInputs.inflation.recoveries ?? expenseInflation;
    const monthlyExpenseInflationRate = Math.pow(1 + expenseInflation, 1 / 12) - 1;
    const monthlyTaxInflationRate = Math.pow(1 + taxInflation, 1 / 12) - 1;
    const monthlyRecoveriesInflationRate = Math.pow(1 + recoveriesInflation, 1 / 12) - 1;

    const expenseValues = new Array(totalMonths).fill(0);
    const taxRecoveriesValues = new Array(totalMonths).fill(0);
    const insuranceRecoveriesValues = new Array(totalMonths).fill(0);
    const camRecoveriesValues = new Array(totalMonths).fill(0);

    const taxRecoverable = recoveriesConfig.tax_recoverable ?? true;
    const insuranceRecoverable = recoveriesConfig.insurance_recoverable ?? true;
    const camRecoverable = recoveriesConfig.cam_recoverable ?? true;

    for (let m = 0; m < totalMonths; m++) {
      const expenseFactor = Math.pow(1 + monthlyExpenseInflationRate, m);
      const taxFactor = Math.pow(1 + monthlyTaxInflationRate, m);
      const recoveryFactor = Math.pow(1 + monthlyRecoveriesInflationRate, m);

      const taxesExpense = monthlyBaseExpense * EXPENSE_WEIGHTS.taxes * taxFactor;
      const insuranceExpense = monthlyBaseExpense * EXPENSE_WEIGHTS.insurance * expenseFactor;
      const camExpense = monthlyBaseExpense * EXPENSE_WEIGHTS.cam * expenseFactor;

      expenseValues[m] = taxesExpense + insuranceExpense + camExpense;

      taxRecoveriesValues[m] = taxRecoverable ? monthlyBaseExpense * EXPENSE_WEIGHTS.taxes * recoveryFactor : 0;
      insuranceRecoveriesValues[m] = insuranceRecoverable ? monthlyBaseExpense * EXPENSE_WEIGHTS.insurance * recoveryFactor : 0;
      camRecoveriesValues[m] = camRecoverable ? monthlyBaseExpense * EXPENSE_WEIGHTS.cam * recoveryFactor : 0;
    }

    // Add reserves
    const reservesValues = new Array(totalMonths).fill(0);
    const baseReserves = operatingInputs.expenses.fixed_annual?.reserves ?? 0;
    const reservesGrowth = operatingInputs.expenses.fixed_annual?.reserves_growth_pct ?? 0;
    if (baseReserves > 0) {
      for (let m = 0; m < totalMonths; m++) {
        const yearIndex = Math.floor(m / 12);
        reservesValues[m] = (baseReserves * Math.pow(1 + reservesGrowth, yearIndex)) / 12;
      }
    }
    if (operatingInputs.reserves_schedule) {
      for (const entry of operatingInputs.reserves_schedule) {
        const monthlyReserve = entry.amount / 12;
        for (let m = 0; m < totalMonths; m++) {
          if (timeline.dateAt(m).year === entry.year) {
            reservesValues[m] += monthlyReserve;
          }
        }
      }
    }
    for (let m = 0; m < totalMonths; m++) {
      expenseValues[m] += reservesValues[m];
    }

    // Apply CAM cap
    const camCap = recoveriesConfig.caps?.cam_annual_increase_cap;
    if (camCap !== undefined && camCap > 0) {
      const monthlyCamCapRate = Math.pow(1 + camCap, 1 / 12) - 1;
      for (let m = 1; m < totalMonths; m++) {
        const maxAllowed = camRecoveriesValues[m - 1] * (1 + monthlyCamCapRate);
        if (camRecoveriesValues[m] > maxAllowed) {
          camRecoveriesValues[m] = maxAllowed;
        }
      }
    }

    const recoveriesValues = new Array(totalMonths).fill(0).map((_, idx) =>
      taxRecoveriesValues[idx] + insuranceRecoveriesValues[idx] + camRecoveriesValues[idx]
    );

    let recoveries: Series;
    if (recoveryMode === "NNN") {
      recoveries = new Series(recoveriesValues.map((v) => v * (1 + adminFeePct)));
    } else if (recoveryMode === "MOD_GROSS") {
      recoveries = new Series(recoveriesValues.map((v) => v * 0.5 * (1 + adminFeePct)));
    } else {
      recoveries = Series.zeros(totalMonths);
    }

    return {
      totalExpenses: new Series(expenseValues),
      recoveries,
    };
  }
}
