import { Series } from "../../core/series.js";
import { DealContext } from "../../types/context.js";
import { OperatingInput } from "../../types/inputs.js";
import { Module, ModuleResult, ValidationResult } from "../../types/module.js";
import { LeaseModuleOutputs } from "../lease/lease-module.js";

export interface OperatingModuleOutputs {
  vacancyLoss: Series;
  creditLoss: Series;
  effectiveGrossIncome: Series;
  operatingExpenses: Series;
  expenseRecoveries: Series;
  netOperatingIncome: Series;
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

    // Calculate operating expenses (simplified - assume base expense per SF with inflation)
    // In a full implementation, this would be more detailed
    const baseExpensePerSf = 3.0; // Base annual expense per SF
    const grossSf = context.inputs.deal.gross_sf;
    const monthlyBaseExpense = (baseExpensePerSf * grossSf) / 12;
    const expenseInflation = operatingInputs.inflation.expenses;
    const taxInflation = operatingInputs.inflation.taxes;
    const recoveriesInflation = operatingInputs.inflation.recoveries ?? operatingInputs.inflation.expenses;
    const monthlyExpenseInflationRate = Math.pow(1 + expenseInflation, 1 / 12) - 1;
    const monthlyTaxInflationRate = Math.pow(1 + taxInflation, 1 / 12) - 1;
    const monthlyRecoveriesInflationRate = Math.pow(1 + recoveriesInflation, 1 / 12) - 1;

    const expenseValues = new Array(totalMonths).fill(0);
    const taxRecoveriesValues = new Array(totalMonths).fill(0);
    const insuranceRecoveriesValues = new Array(totalMonths).fill(0);
    const camRecoveriesValues = new Array(totalMonths).fill(0);

    const recoveriesConfig = operatingInputs.expenses.recoveries;
    const taxRecoverable = recoveriesConfig.tax_recoverable ?? true;
    const insuranceRecoverable = recoveriesConfig.insurance_recoverable ?? true;
    const camRecoverable = recoveriesConfig.cam_recoverable ?? true;
    const adminFeePct = recoveriesConfig.admin_fee_pct ?? 0;

    for (let m = 0; m < totalMonths; m++) {
      const expenseFactor = Math.pow(1 + monthlyExpenseInflationRate, m);
      const taxFactor = Math.pow(1 + monthlyTaxInflationRate, m);
      const recoveryFactor = Math.pow(1 + monthlyRecoveriesInflationRate, m);

      const taxesExpense = monthlyBaseExpense * EXPENSE_WEIGHTS.taxes * taxFactor;
      const insuranceExpense = monthlyBaseExpense * EXPENSE_WEIGHTS.insurance * expenseFactor;
      const camExpense = monthlyBaseExpense * EXPENSE_WEIGHTS.cam * expenseFactor;

      expenseValues[m] = taxesExpense + insuranceExpense + camExpense;

      const taxesRecovery = taxRecoverable
        ? monthlyBaseExpense * EXPENSE_WEIGHTS.taxes * recoveryFactor
        : 0;
      const insuranceRecovery = insuranceRecoverable
        ? monthlyBaseExpense * EXPENSE_WEIGHTS.insurance * recoveryFactor
        : 0;
      const camRecovery = camRecoverable
        ? monthlyBaseExpense * EXPENSE_WEIGHTS.cam * recoveryFactor
        : 0;

      taxRecoveriesValues[m] = taxesRecovery;
      insuranceRecoveriesValues[m] = insuranceRecovery;
      camRecoveriesValues[m] = camRecovery;
    }

    const reservesValues = new Array(totalMonths).fill(0);
    const baseReserves = operatingInputs.expenses.fixed_annual?.reserves ?? 0;
    const reservesGrowth = operatingInputs.expenses.fixed_annual?.reserves_growth_pct ?? 0;
    if (baseReserves > 0) {
      for (let m = 0; m < totalMonths; m++) {
        const yearIndex = Math.floor(m / 12);
        const annualReserves = baseReserves * Math.pow(1 + reservesGrowth, yearIndex);
        reservesValues[m] += annualReserves / 12;
      }
    }
    if (operatingInputs.reserves_schedule && operatingInputs.reserves_schedule.length > 0) {
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

    const recoveriesValues = new Array(totalMonths).fill(0).map((_, idx) => {
      return (
        (taxRecoveriesValues[idx] ?? 0) +
        (insuranceRecoveriesValues[idx] ?? 0) +
        (camRecoveriesValues[idx] ?? 0)
      );
    });

    // Calculate expense recoveries based on lease type
    let expenseRecoveries = Series.zeros(totalMonths);
    const recoveryMode = operatingInputs.expenses.recoveries.mode;

    if (recoveryMode === "NNN") {
      // NNN: Full expense recovery from tenants
      const totals = recoveriesValues.map((value, idx) => {
        return value * (1 + adminFeePct);
      });
      expenseRecoveries = new Series(totals);
    } else if (recoveryMode === "MOD_GROSS") {
      // Modified Gross: Partial recovery (50% for simplicity)
      const totals = recoveriesValues.map((value, idx) => {
        return value * 0.5 * (1 + adminFeePct);
      });
      expenseRecoveries = new Series(totals);
    }
    // GROSS: No recoveries (stays at zeros)

    const operatingExpenses = new Series(expenseValues);

    // Calculate NOI
    const netOperatingIncome = effectiveGrossIncome
      .subtract(operatingExpenses)
      .add(expenseRecoveries);

    const outputs: OperatingModuleOutputs = {
      vacancyLoss,
      creditLoss,
      effectiveGrossIncome,
      operatingExpenses,
      expenseRecoveries,
      netOperatingIncome,
    };

    // Update context
    context.outputs.operating = outputs;
    context.cashflows.expenses = operatingExpenses.subtract(expenseRecoveries);
    context.cashflows.noi = netOperatingIncome;

    // Calculate Year 1 NOI for metrics
    context.metrics.noiYear1 = netOperatingIncome.forward12(0);

    return { success: true, outputs };
  }
}
