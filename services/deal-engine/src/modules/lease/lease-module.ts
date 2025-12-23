import { DateTime } from "luxon";
import { Series } from "../../core/series";
import { DealContext } from "../../types/context";
import {
  InPlaceTenantInput,
  LeaseInput,
  MarketRolloverTenantInput,
} from "../../types/inputs";
import { Module, ModuleResult, ValidationResult } from "../../types/module";

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

    leaseInputs.tenants_in_place.forEach((tenant, idx) => {
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
    });

    if (leaseInputs.market_rollover) {
      leaseInputs.market_rollover.forEach((tenant, idx) => {
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

    // Calculate rent for each month
    for (let m = 0; m < totalMonths; m++) {
      if (m >= leaseStartMonth && m < leaseEndMonth) {
        // Calculate years since lease start for bump calculation
        const monthsSinceStart = m - leaseStartMonth;
        const yearsSinceStart = Math.floor(monthsSinceStart / 12);
        const rentWithBump = monthlyRent * Math.pow(1 + bumpRate, yearsSinceStart);
        monthlyRentValues[m] = rentWithBump;
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

    // Calculate rent for each month
    for (let m = 0; m < totalMonths; m++) {
      if (m >= leaseStartMonth && m < leaseEndMonth) {
        const monthsSinceStart = m - leaseStartMonth;
        const yearsSinceStart = Math.floor(monthsSinceStart / 12);
        const rentWithBump = monthlyRent * Math.pow(1 + bumpRate, yearsSinceStart);
        monthlyRentValues[m] = rentWithBump;
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
