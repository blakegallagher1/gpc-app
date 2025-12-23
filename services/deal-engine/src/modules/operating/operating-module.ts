import { Series } from "../../core/series";
import { DealContext } from "../../types/context";
import { OperatingInput } from "../../types/inputs";
import { Module, ModuleResult, ValidationResult } from "../../types/module";
import { LeaseModuleOutputs } from "../lease/lease-module";

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
  },
  expenses: {
    recoveries: {
      mode: "NNN",
    },
  },
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
    const monthlyInflationRate = Math.pow(1 + expenseInflation, 1 / 12) - 1;

    const expenseValues = new Array(totalMonths).fill(0).map((_, m) => {
      return monthlyBaseExpense * Math.pow(1 + monthlyInflationRate, m);
    });
    const operatingExpenses = new Series(expenseValues);

    // Calculate expense recoveries based on lease type
    let expenseRecoveries = Series.zeros(totalMonths);
    const recoveryMode = operatingInputs.expenses.recoveries.mode;

    if (recoveryMode === "NNN") {
      // NNN: Full expense recovery from tenants
      expenseRecoveries = operatingExpenses;
    } else if (recoveryMode === "MOD_GROSS") {
      // Modified Gross: Partial recovery (50% for simplicity)
      expenseRecoveries = operatingExpenses.multiply(0.5);
    }
    // GROSS: No recoveries (stays at zeros)

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
