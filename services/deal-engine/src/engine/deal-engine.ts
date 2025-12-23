import { Timeline } from "../core/timeline";
import { Series } from "../core/series";
import { DealContext, DealMetrics } from "../types/context";
import { DealEngineInputs } from "../types/inputs";
import { Module, ValidationResult, ValidationError } from "../types/module";
import { LeaseModule } from "../modules/lease/lease-module";
import { OperatingModule } from "../modules/operating/operating-module";
import { DebtModule } from "../modules/debt/debt-module";
import { ExitModule } from "../modules/exit/exit-module";

export interface DealEngineResult {
  success: boolean;
  context?: DealContext;
  errors?: string[];
  warnings: string[];
}

export interface DealEngineValidation {
  valid: boolean;
  errors: ValidationError[];
}

export class DealEngine {
  private readonly modules: Module<unknown>[];

  constructor() {
    // Initialize modules in execution order
    this.modules = [
      new LeaseModule(),
      new OperatingModule(),
      new DebtModule(),
      new ExitModule(),
    ];
  }

  /**
   * Validate all module inputs
   */
  validateAll(inputs: DealEngineInputs): DealEngineValidation {
    const allErrors: ValidationError[] = [];

    // Validate deal-level inputs
    if (!inputs.deal) {
      allErrors.push({ path: "deal", message: "deal is required" });
    } else {
      if (!inputs.deal.analysis_start_date) {
        allErrors.push({ path: "deal.analysis_start_date", message: "analysis_start_date is required" });
      }
      if (!inputs.deal.hold_period_months || inputs.deal.hold_period_months <= 0) {
        allErrors.push({ path: "deal.hold_period_months", message: "hold_period_months must be positive" });
      }
    }

    // Validate acquisition inputs
    if (!inputs.modules?.acquisition) {
      allErrors.push({ path: "modules.acquisition", message: "acquisition is required" });
    }

    // Validate each module
    for (const module of this.modules) {
      const moduleInputs = this.getModuleInputs(inputs, module.name);
      const validation = module.validate(moduleInputs);
      if (!validation.valid) {
        allErrors.push(...validation.errors);
      }
    }

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
    };
  }

  /**
   * Run the full deal engine computation
   */
  async run(inputs: DealEngineInputs): Promise<DealEngineResult> {
    const warnings: string[] = [];

    // Validate inputs
    const validation = this.validateAll(inputs);
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors.map((e) => `${e.path}: ${e.message}`),
        warnings,
      };
    }

    // Create timeline
    let timeline: Timeline;
    try {
      timeline = new Timeline({
        startDate: inputs.deal.analysis_start_date,
        holdPeriodMonths: inputs.deal.hold_period_months,
        exitMonth: inputs.modules.exit?.exit_month,
      });
    } catch (e) {
      return {
        success: false,
        errors: [`Failed to create timeline: ${(e as Error).message}`],
        warnings,
      };
    }

    // Initialize context
    const context: DealContext = {
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

    // Run modules in order
    for (const module of this.modules) {
      try {
        const result = module.compute(context);
        if (!result.success) {
          return {
            success: false,
            errors: result.errors ?? [`Module ${module.name} failed`],
            warnings: context.warnings,
          };
        }
      } catch (e) {
        return {
          success: false,
          errors: [`Module ${module.name} threw: ${(e as Error).message}`],
          warnings: context.warnings,
        };
      }
    }

    // Calculate summary metrics
    this.calculateSummaryMetrics(context);

    return {
      success: true,
      context,
      warnings: context.warnings,
    };
  }

  /**
   * Get module-specific inputs from the full inputs object
   */
  private getModuleInputs(inputs: DealEngineInputs, moduleName: string): unknown {
    switch (moduleName) {
      case "lease":
        return inputs.modules?.lease;
      case "operating":
        return inputs.modules?.operating;
      case "debt":
        return inputs.modules?.debt;
      case "exit":
        return inputs.modules?.exit;
      default:
        return undefined;
    }
  }

  /**
   * Calculate and populate summary metrics
   */
  private calculateSummaryMetrics(context: DealContext): void {
    const metrics = context.metrics;
    const inputs = context.inputs;

    // Going-in cap rate
    if (metrics.noiYear1 && inputs.modules.acquisition.purchase_price > 0) {
      metrics.goingInCapRate = metrics.noiYear1 / inputs.modules.acquisition.purchase_price;
    }

    // Exit cap rate is set by ExitModule

    // Add warnings for key metrics
    if (metrics.leveredIrr !== undefined && metrics.leveredIrr < 0) {
      context.warnings.push("Levered IRR is negative - deal may not be profitable");
    }

    if (metrics.averageDscr !== undefined && metrics.averageDscr < 1.25) {
      context.warnings.push(`Average DSCR of ${metrics.averageDscr.toFixed(2)} is below typical lender requirements (1.25x)`);
    }

    if (metrics.equityMultiple !== undefined && metrics.equityMultiple < 1.0) {
      context.warnings.push("Equity multiple is below 1.0x - investor will lose money");
    }
  }
}

/**
 * Create a summary report from deal engine results
 */
export function createSummaryReport(result: DealEngineResult): string {
  if (!result.success || !result.context) {
    return `Deal Engine Failed:\n${result.errors?.join("\n") ?? "Unknown error"}`;
  }

  const ctx = result.context;
  const m = ctx.metrics;

  const lines: string[] = [
    "=".repeat(60),
    `DEAL SUMMARY: ${ctx.inputs.deal.project_name}`,
    "=".repeat(60),
    "",
    "LOCATION",
    `  ${ctx.inputs.deal.city}, ${ctx.inputs.deal.state}`,
    "",
    "PROPERTY",
    `  Gross SF: ${ctx.inputs.deal.gross_sf.toLocaleString()}`,
    `  Net SF: ${ctx.inputs.deal.net_sf.toLocaleString()}`,
    "",
    "ACQUISITION",
    `  Purchase Price: $${ctx.inputs.modules.acquisition.purchase_price.toLocaleString()}`,
    `  Going-In Cap: ${(m.goingInCapRate ?? 0) * 100}%`,
    "",
    "RETURNS",
    `  Unlevered IRR: ${((m.unleveredIrr ?? 0) * 100).toFixed(2)}%`,
    `  Levered IRR: ${((m.leveredIrr ?? 0) * 100).toFixed(2)}%`,
    `  Equity Multiple: ${(m.equityMultiple ?? 0).toFixed(2)}x`,
    "",
    "DEBT",
    `  Avg DSCR: ${(m.averageDscr ?? 0).toFixed(2)}x`,
    "",
    "EXIT",
    `  Exit Cap: ${((m.exitCapRate ?? 0) * 100).toFixed(2)}%`,
    `  Exit Month: ${ctx.timeline.exitMonth}`,
    "",
    "NOI",
    `  Year 1: $${(m.noiYear1 ?? 0).toLocaleString()}`,
  ];

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("WARNINGS");
    for (const warning of result.warnings) {
      lines.push(`  ⚠️ ${warning}`);
    }
  }

  lines.push("");
  lines.push("=".repeat(60));

  return lines.join("\n");
}
