import { irr } from "../../core/math-utils.js";
import { DealContext } from "../../types/context.js";
import { WaterfallInput, WaterfallTierInput } from "../../types/inputs.js";
import { Module, ModuleResult, ValidationResult } from "../../types/module.js";
import { ExitModuleOutputs } from "../exit/exit-module.js";

export interface WaterfallModuleOutputs {
  lpShare: number;
  gpShare: number;
  lpDistributions: number[];
  gpDistributions: number[];
  lpIrr: number;
  gpIrr: number;
  lpMultiple: number;
  gpMultiple: number;
  lpEquityInvestment: number;
  gpEquityInvestment: number;
}

type WaterfallModuleResult = ModuleResult<WaterfallModuleOutputs>;

const DEFAULT_LP_SHARE = 0.9;
const DEFAULT_GP_SHARE = 0.1;

function assertWaterfallInput(inputs: unknown): asserts inputs is WaterfallInput | undefined {
  if (inputs === undefined) return;
  if (typeof inputs !== "object" || inputs === null) {
    throw new TypeError("waterfall must be an object");
  }
  const inp = inputs as Record<string, unknown>;
  if (typeof inp.enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean");
  }
}

function isWaterfallTier(value: unknown): value is WaterfallTierInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const tier = value as Record<string, unknown>;
  const hasSplit =
    typeof tier.promote_split === "number" ||
    typeof tier.lp_split === "number" ||
    typeof tier.gp_split === "number";
  return typeof tier.hurdle_irr === "number" && hasSplit;
}

export class WaterfallModule implements Module<WaterfallModuleOutputs> {
  readonly name = "waterfall";
  readonly version = "0.1.0";
  readonly dependencies: readonly string[] = ["exit"];

  validate(inputs: unknown): ValidationResult {
    const errors: { path: string; message: string }[] = [];

    try {
      assertWaterfallInput(inputs);
    } catch (e) {
      errors.push({ path: "waterfall", message: (e as Error).message });
      return { valid: false, errors };
    }

    const waterfallInputs = inputs as WaterfallInput | undefined;

    if (waterfallInputs?.enabled && !Array.isArray(waterfallInputs.tiers)) {
      errors.push({
        path: "waterfall.tiers",
        message: "tiers must be an array when waterfall is enabled",
      });
    }

    if (waterfallInputs?.tiers) {
      waterfallInputs.tiers.forEach((tier, idx) => {
        if (!isWaterfallTier(tier)) {
          errors.push({
            path: `waterfall.tiers[${idx}]`,
            message: "tier must include hurdle_irr and at least one split",
          });
          return;
        }
        if (tier.hurdle_irr < 0 || tier.hurdle_irr > 1) {
          errors.push({
            path: `waterfall.tiers[${idx}].hurdle_irr`,
            message: "hurdle_irr must be between 0 and 1",
          });
        }
        if (tier.promote_split !== undefined && (tier.promote_split < 0 || tier.promote_split > 1)) {
          errors.push({
            path: `waterfall.tiers[${idx}].promote_split`,
            message: "promote_split must be between 0 and 1",
          });
        }
        if (tier.lp_split !== undefined && (tier.lp_split < 0 || tier.lp_split > 1)) {
          errors.push({
            path: `waterfall.tiers[${idx}].lp_split`,
            message: "lp_split must be between 0 and 1",
          });
        }
        if (tier.gp_split !== undefined && (tier.gp_split < 0 || tier.gp_split > 1)) {
          errors.push({
            path: `waterfall.tiers[${idx}].gp_split`,
            message: "gp_split must be between 0 and 1",
          });
        }
        if (
          tier.lp_split !== undefined &&
          tier.gp_split !== undefined &&
          tier.lp_split + tier.gp_split > 1
        ) {
          errors.push({
            path: `waterfall.tiers[${idx}]`,
            message: "lp_split plus gp_split must be less than or equal to 1",
          });
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  compute(context: DealContext): WaterfallModuleResult {
    const waterfallInputs = context.inputs.modules.waterfall;
    const exitOutputs = context.outputs.exit as ExitModuleOutputs | undefined;

    if (!exitOutputs) {
      return {
        success: false,
        errors: ["ExitModule must be computed before WaterfallModule"],
      };
    }

    if (waterfallInputs?.enabled && waterfallInputs.tiers?.length) {
      context.warnings.push("Waterfall tiers are not yet supported; using pro-rata split");
    }

    const lpShare = DEFAULT_LP_SHARE;
    const gpShare = DEFAULT_GP_SHARE;

    const leveredCashflows = exitOutputs.leveredCashflows;
    const rawEquityInvestment = leveredCashflows.length > 0 ? -leveredCashflows[0] : 0;
    const equityInvestment = rawEquityInvestment > 0 ? rawEquityInvestment : 0;

    const lpDistributions: number[] = leveredCashflows.map((cf) => cf * lpShare);
    const gpDistributions: number[] = leveredCashflows.map((cf) => cf * gpShare);

    let lpIrr = 0;
    let gpIrr = 0;

    try {
      lpIrr = irr(lpDistributions) * 12;
    } catch {
      context.warnings.push("Could not calculate LP IRR");
    }

    try {
      gpIrr = irr(gpDistributions) * 12;
    } catch {
      context.warnings.push("Could not calculate GP IRR");
    }

    const lpEquityInvestment = equityInvestment * lpShare;
    const gpEquityInvestment = equityInvestment * gpShare;

    const lpTotalReceived = lpDistributions.slice(1).reduce((sum, cf) => sum + cf, 0);
    const gpTotalReceived = gpDistributions.slice(1).reduce((sum, cf) => sum + cf, 0);

    const lpMultiple = lpEquityInvestment > 0 ? lpTotalReceived / lpEquityInvestment : 0;
    const gpMultiple = gpEquityInvestment > 0 ? gpTotalReceived / gpEquityInvestment : 0;

    const outputs: WaterfallModuleOutputs = {
      lpShare,
      gpShare,
      lpDistributions,
      gpDistributions,
      lpIrr,
      gpIrr,
      lpMultiple,
      gpMultiple,
      lpEquityInvestment,
      gpEquityInvestment,
    };

    context.outputs.waterfall = outputs;
    context.metrics.lpIrr = lpIrr;
    context.metrics.gpIrr = gpIrr;

    return { success: true, outputs };
  }
}
