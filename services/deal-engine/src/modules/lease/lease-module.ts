import { DateTime } from "luxon";
import { Series } from "../../core/series.js";
import { DealContext } from "../../types/context.js";
import {
  InPlaceTenantInput,
  LeaseInput,
  MarketRolloverTenantInput,
  RentStepInput,
} from "../../types/inputs.js";
import { Module, ModuleResult, ValidationResult } from "../../types/module.js";

export interface TenantSchedule {
  tenantName: string;
  sf: number;
  monthlyRent: Series;
  freeRentMonths: number;
  tiCost: number;
  lcCost: number;
}

export interface LeaseModuleOutputs {
  tenantSchedules: TenantSchedule[];
  grossPotentialRent: Series;
  freeRentAbatement: Series;
  effectiveGrossRevenue: Series;
  totalTiCost: number;
  totalLcCost: number;
}

type LeaseModuleResult = ModuleResult<LeaseModuleOutputs>;

function assertLeaseInput(inputs: unknown): asserts inputs is LeaseInput {
  if (!inputs || typeof inputs !== "object") {
    throw new TypeError("inputs must be an object");
  }
  const inp = inputs as Record<string, unknown>;
  if (!Array.isArray(inp.tenants_in_place)) {
    throw new TypeError("tenants_in_place must be an array");
  }
}

function validateRentSteps(
  steps: unknown,
  pathPrefix: string,
  errors: { path: string; message: string }[]
): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push({
      path: `${pathPrefix}.rent_steps`,
      message: "rent_steps must be a non-empty array when economics_mode=steps",
    });
    return;
  }

  steps.forEach((step, idx) => {
    if (!step || typeof step !== "object") {
      errors.push({
        path: `${pathPrefix}.rent_steps[${idx}]`,
        message: "rent_step must be an object",
      });
      return;
    }
    const stepObj = step as Record<string, unknown>;
    const start = stepObj.start_date;
    const end = stepObj.end_date;
    const rentPsf = stepObj.rent_psf;
    if (typeof start !== "string" || typeof end !== "string") {
      errors.push({
        path: `${pathPrefix}.rent_steps[${idx}]`,
        message: "start_date and end_date are required",
      });
    } else {
      const startDate = DateTime.fromISO(start, { zone: "utc" });
      const endDate = DateTime.fromISO(end, { zone: "utc" });
      if (!startDate.isValid || !endDate.isValid) {
        errors.push({
          path: `${pathPrefix}.rent_steps[${idx}]`,
          message: "start_date and end_date must be valid dates",
        });
      } else if (endDate <= startDate) {
        errors.push({
          path: `${pathPrefix}.rent_steps[${idx}].end_date`,
          message: "end_date must be after start_date",
        });
      }
    }
    if (typeof rentPsf !== "number" || rentPsf < 0) {
      errors.push({
        path: `${pathPrefix}.rent_steps[${idx}].rent_psf`,
        message: "rent_psf must be a non-negative number",
      });
    }
  });
}

export class LeaseModule implements Module<LeaseModuleOutputs> {
  readonly name = "lease";
  readonly version = "0.1.0";
  readonly dependencies: readonly string[] = [];

  validate(inputs: unknown): ValidationResult {
    const errors: { path: string; message: string }[] = [];

    try {
      assertLeaseInput(inputs);
    } catch (e) {
      errors.push({ path: "lease", message: (e as Error).message });
      return { valid: false, errors };
    }

    const leaseInputs = inputs as LeaseInput;

    leaseInputs.tenants_in_place.forEach((tenant: InPlaceTenantInput, idx: number) => {
      if (!tenant.tenant_name) {
        errors.push({
          path: `tenants_in_place[${idx}].tenant_name`,
          message: "tenant_name is required",
        });
      }
      if (typeof tenant.sf !== "number" || tenant.sf <= 0) {
        errors.push({
          path: `tenants_in_place[${idx}].sf`,
          message: "sf must be a positive number",
        });
      }
      if (typeof tenant.current_rent_psf_annual !== "number" || tenant.current_rent_psf_annual < 0) {
        errors.push({
          path: `tenants_in_place[${idx}].current_rent_psf_annual`,
          message: "current_rent_psf_annual must be a non-negative number",
        });
      }
      if (tenant.economics_mode === "steps") {
        validateRentSteps(tenant.rent_steps, `tenants_in_place[${idx}]`, errors);
      }
    });

    if (leaseInputs.market_rollover) {
      leaseInputs.market_rollover.forEach((tenant: MarketRolloverTenantInput, idx: number) => {
        if (!tenant.tenant_name) {
          errors.push({
            path: `market_rollover[${idx}].tenant_name`,
            message: "tenant_name is required",
          });
        }
        if (typeof tenant.market_rent_psf_annual !== "number" || tenant.market_rent_psf_annual < 0) {
          errors.push({
            path: `market_rollover[${idx}].market_rent_psf_annual`,
            message: "market_rent_psf_annual must be a non-negative number",
          });
        }
        if (tenant.economics_mode === "steps") {
          validateRentSteps(tenant.rent_steps, `market_rollover[${idx}]`, errors);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  compute(context: DealContext): LeaseModuleResult {
    const leaseInputs = context.inputs.modules.lease;
    const timeline = context.timeline;
    const totalMonths = timeline.totalMonths;

    const tenantSchedules: TenantSchedule[] = [];
    let totalTiCost = 0;
    let totalLcCost = 0;

    // Process in-place tenants
    for (const tenant of leaseInputs.tenants_in_place) {
      const schedule = this.computeInPlaceTenant(tenant, timeline);
      tenantSchedules.push(schedule);
      totalTiCost += schedule.tiCost;
      totalLcCost += schedule.lcCost;
    }

    // Process market rollover tenants
    if (leaseInputs.market_rollover) {
      for (const tenant of leaseInputs.market_rollover) {
        const schedule = this.computeRolloverTenant(
          tenant,
          timeline,
          context.inputs.deal.net_sf
        );
        tenantSchedules.push(schedule);
        totalTiCost += schedule.tiCost;
        totalLcCost += schedule.lcCost;
      }
    }

    // Aggregate all tenant rents into gross potential rent
    let grossPotentialRent = Series.zeros(totalMonths);
    let freeRentAbatement = Series.zeros(totalMonths);

    for (const schedule of tenantSchedules) {
      grossPotentialRent = grossPotentialRent.add(schedule.monthlyRent);

      // Calculate free rent abatement for this tenant
      if (schedule.freeRentMonths > 0) {
        const abatementValues = new Array(totalMonths).fill(0);
        for (let m = 0; m < Math.min(schedule.freeRentMonths, totalMonths); m++) {
          abatementValues[m] = schedule.monthlyRent.get(m);
        }
        freeRentAbatement = freeRentAbatement.add(new Series(abatementValues));
      }
    }

    const effectiveGrossRevenue = grossPotentialRent.subtract(freeRentAbatement);

    const outputs: LeaseModuleOutputs = {
      tenantSchedules,
      grossPotentialRent,
      freeRentAbatement,
      effectiveGrossRevenue,
      totalTiCost,
      totalLcCost,
    };

    // Update context
    context.outputs.lease = outputs;
    context.cashflows.revenue = effectiveGrossRevenue;

    return { success: true, outputs };
  }

  private applyRentSteps(
    steps: RentStepInput[],
    monthlyRentValues: number[],
    sf: number,
    timeline: { startDate: DateTime; totalMonths: number; monthIndex: (d: string) => number },
    leaseStartMonth: number,
    leaseEndMonth: number
  ): void {
    for (const step of steps) {
      const stepStart = timeline.monthIndex(step.start_date);
      const stepEnd = timeline.monthIndex(step.end_date);
      const startMonth = Math.max(leaseStartMonth, stepStart);
      const endMonth = Math.min(leaseEndMonth, stepEnd, timeline.totalMonths);
      const stepMonthlyRent = (step.rent_psf * sf) / 12;

      for (let m = startMonth; m < endMonth; m++) {
        monthlyRentValues[m] = stepMonthlyRent;
      }
    }
  }

  private computeInPlaceTenant(
    tenant: InPlaceTenantInput,
    timeline: { startDate: DateTime; totalMonths: number; monthIndex: (d: string) => number }
  ): TenantSchedule {
    const totalMonths = timeline.totalMonths;
    const monthlyRentValues = new Array(totalMonths).fill(0);

    const leaseStart = DateTime.fromISO(tenant.lease_start, { zone: "utc" });
    const leaseEnd = DateTime.fromISO(tenant.lease_end, { zone: "utc" });

    const leaseStartMonth = timeline.monthIndex(tenant.lease_start);
    const leaseEndMonth = timeline.monthIndex(tenant.lease_end);

    const annualRent = tenant.current_rent_psf_annual * tenant.sf;
    const monthlyRent = annualRent / 12;
    const bumpRate = tenant.annual_bump_pct ?? 0;
    const economicsMode = tenant.economics_mode ?? "bump";

    // Calculate rent for each month
    if (economicsMode === "steps" && tenant.rent_steps && tenant.rent_steps.length > 0) {
      this.applyRentSteps(
        tenant.rent_steps,
        monthlyRentValues,
        tenant.sf,
        timeline,
        leaseStartMonth,
        leaseEndMonth,
      );
    } else {
      for (let m = 0; m < totalMonths; m++) {
        if (m >= leaseStartMonth && m < leaseEndMonth) {
          // Calculate years since lease start for bump calculation
          const monthsSinceStart = m - leaseStartMonth;
          const yearsSinceStart = Math.floor(monthsSinceStart / 12);
          const rentWithBump = monthlyRent * Math.pow(1 + bumpRate, yearsSinceStart);
          monthlyRentValues[m] = rentWithBump;
        }
      }
    }

    // Calculate TI cost
    let tiCost = 0;
    if (tenant.ti) {
      if (tenant.ti.mode === "PER_SF") {
        tiCost = (tenant.ti.value ?? 0) * tenant.sf;
      } else if (tenant.ti.mode === "FIXED") {
        tiCost = tenant.ti.value ?? 0;
      }
    }

    // Calculate LC cost
    let lcCost = 0;
    if (tenant.lc) {
      const leaseTerm = leaseEnd.diff(leaseStart, "months").months;
      const totalLeaseRent = monthlyRent * leaseTerm;
      if (tenant.lc.mode === "PCT_RENT") {
        lcCost = (tenant.lc.value ?? 0) * totalLeaseRent;
      } else if (tenant.lc.mode === "PER_SF") {
        lcCost = (tenant.lc.value ?? 0) * tenant.sf;
      } else if (tenant.lc.mode === "FIXED") {
        lcCost = tenant.lc.value ?? 0;
      }
    }

    return {
      tenantName: tenant.tenant_name,
      sf: tenant.sf,
      monthlyRent: new Series(monthlyRentValues),
      freeRentMonths: tenant.free_rent_months ?? 0,
      tiCost,
      lcCost,
    };
  }

  private computeRolloverTenant(
    tenant: MarketRolloverTenantInput,
    timeline: { startDate: DateTime; totalMonths: number; monthIndex: (d: string) => number },
    defaultSf: number
  ): TenantSchedule {
    const totalMonths = timeline.totalMonths;
    const monthlyRentValues = new Array(totalMonths).fill(0);

    const sf = tenant.sf ?? defaultSf;
    const downtimeMonths = tenant.downtime_months ?? 0;

    const leaseStartMonth = timeline.monthIndex(tenant.lease_start) + downtimeMonths;
    const leaseEndMonth = timeline.monthIndex(tenant.lease_end);

    const annualRent = tenant.market_rent_psf_annual * sf;
    const monthlyRent = annualRent / 12;
    const bumpRate = tenant.annual_bump_pct ?? 0;
    const economicsMode = tenant.economics_mode ?? "bump";

    if (economicsMode === "steps" && tenant.rent_steps && tenant.rent_steps.length > 0) {
      this.applyRentSteps(
        tenant.rent_steps,
        monthlyRentValues,
        sf,
        timeline,
        leaseStartMonth,
        leaseEndMonth,
      );
    } else {
      // Calculate rent for each month
      for (let m = 0; m < totalMonths; m++) {
        if (m >= leaseStartMonth && m < leaseEndMonth) {
          const monthsSinceStart = m - leaseStartMonth;
          const yearsSinceStart = Math.floor(monthsSinceStart / 12);
          const rentWithBump = monthlyRent * Math.pow(1 + bumpRate, yearsSinceStart);
          monthlyRentValues[m] = rentWithBump;
        }
      }
    }

    // Calculate TI cost
    let tiCost = 0;
    if (tenant.ti) {
      if (tenant.ti.mode === "PER_SF") {
        tiCost = (tenant.ti.value ?? 0) * sf;
      } else if (tenant.ti.mode === "FIXED") {
        tiCost = tenant.ti.value ?? 0;
      }
    }

    // Calculate LC cost
    let lcCost = 0;
    if (tenant.lc) {
      const leaseStart = DateTime.fromISO(tenant.lease_start, { zone: "utc" });
      const leaseEnd = DateTime.fromISO(tenant.lease_end, { zone: "utc" });
      const leaseTerm = leaseEnd.diff(leaseStart, "months").months;
      const totalLeaseRent = monthlyRent * leaseTerm;
      if (tenant.lc.mode === "PCT_RENT") {
        lcCost = (tenant.lc.value ?? 0) * totalLeaseRent;
      } else if (tenant.lc.mode === "PER_SF") {
        lcCost = (tenant.lc.value ?? 0) * sf;
      } else if (tenant.lc.mode === "FIXED") {
        lcCost = tenant.lc.value ?? 0;
      }
    }

    return {
      tenantName: tenant.tenant_name,
      sf,
      monthlyRent: new Series(monthlyRentValues),
      freeRentMonths: tenant.free_rent_months ?? 0,
      tiCost,
      lcCost,
    };
  }
}
