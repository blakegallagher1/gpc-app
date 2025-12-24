import { Series } from "../core/series.js";
import type { Timeline } from "../core/timeline.js";
import type { DealContext } from "../runtime/context.js";
import type { DealEngineRequestV0, DealModule } from "../runtime/types.js";

type LeaseMode = "commercial_rent_roll" | "multifamily_unit_mix" | "storage_unit_mix" | "mhp_lot_rent";

type LeaseInput = {
  mode: LeaseMode;
  tenants_in_place?: CommercialTenantInput[];
  unit_types?: UnitTypeInput[];
  lots_total?: number;
  lots_occupied_initial?: number;
  lot_rent_monthly_initial?: number;
  annual_lot_rent_growth_pct?: number;
  occupancy_ramp?: OccupancyRampInput;
  lease_up?: LeaseUpInput;
};

type CommercialTenantInput = {
  tenant_name: string;
  area: { unit: "sf" | "acres"; value: number };
  lease_start: string;
  lease_end: string;
  rent_type: string;
  base_rent: { unit: BaseRentUnit; amount: number };
  annual_bump_pct?: number;
  rent_steps?: RentStepInput[];
};

type RentStepInput = {
  start: string;
  end: string;
  rent: { unit: BaseRentUnit; amount: number };
};

type BaseRentUnit =
  | "psf_annual"
  | "total_monthly"
  | "total_annual"
  | "per_acre_monthly"
  | "per_acre_annual";

type UnitTypeInput = {
  unit_type_id: string;
  name: string;
  count: number;
  avg_sf?: number;
  starting_rent_monthly: number;
  annual_rent_growth_pct: number;
  starting_occupancy_pct?: number;
  stabilized_occupancy_pct?: number;
};

type OccupancyRampInput = {
  start_month: number;
  months_to_stabilize: number;
};

type LeaseUpInput = {
  start_month: number;
  stabilized_occupancy_pct: number;
  absorption_units_per_month: number;
};

type DealEngineRequestShape = {
  modules?: {
    lease?: LeaseInput;
  };
};

export class LeaseModule implements DealModule {
  name = "lease";

  run(ctx: DealContext, request: DealEngineRequestV0): void {
    const lease = (request as DealEngineRequestShape).modules?.lease;
    if (!lease) {
      return;
    }

    const totalMonths = ctx.timeline.totalMonths;
    const rentValues = Array.from({ length: totalMonths }, () => 0);

    switch (lease.mode) {
      case "commercial_rent_roll":
        this.applyCommercialRentRoll(ctx.timeline, lease.tenants_in_place ?? [], rentValues);
        break;
      case "multifamily_unit_mix":
        this.applyUnitMix(lease.unit_types ?? [], lease.lease_up, rentValues, totalMonths);
        break;
      case "storage_unit_mix":
        this.applyUnitMix(lease.unit_types ?? [], undefined, rentValues, totalMonths, lease.occupancy_ramp);
        break;
      case "mhp_lot_rent":
        this.applyMhpLotRent(lease, rentValues, totalMonths);
        break;
      default:
        ctx.addWarning(`Lease mode ${lease.mode} not implemented`);
        break;
    }

    ctx.setSeries("gross_potential_rent", new Series(rentValues));
  }

  private applyCommercialRentRoll(
    timeline: Timeline,
    tenants: CommercialTenantInput[],
    rentValues: number[],
  ): void {
    for (const tenant of tenants) {
      const steps = tenant.rent_steps ?? [];
      if (steps.length > 0) {
        this.applyRentSteps(timeline, tenant, steps, rentValues);
        continue;
      }

      const baseMonthly = this.monthlyRentFromBase(tenant.base_rent, tenant.area.value);
      const startIndex = timeline.monthIndex(tenant.lease_start);
      const endIndex = timeline.monthIndex(tenant.lease_end) + 1;
      const bumpPct = tenant.annual_bump_pct ?? 0;

      for (let month = Math.max(startIndex, 0); month < Math.min(endIndex, rentValues.length); month += 1) {
        if (month < 0) {
          continue;
        }
        const yearsElapsed = Math.floor((month - startIndex) / 12);
        const adjusted = baseMonthly * Math.pow(1 + bumpPct, Math.max(0, yearsElapsed));
        rentValues[month] = (rentValues[month] ?? 0) + adjusted;
      }
    }
  }

  private applyRentSteps(
    timeline: Timeline,
    tenant: CommercialTenantInput,
    steps: RentStepInput[],
    rentValues: number[],
  ): void {
    for (const step of steps) {
      const startIndex = timeline.monthIndex(step.start);
      const endIndex = timeline.monthIndex(step.end) + 1;
      const monthly = this.monthlyRentFromBase(step.rent, tenant.area.value);

      for (let month = Math.max(startIndex, 0); month < Math.min(endIndex, rentValues.length); month += 1) {
        rentValues[month] = (rentValues[month] ?? 0) + monthly;
      }
    }
  }

  private applyUnitMix(
    unitTypes: UnitTypeInput[],
    leaseUp: LeaseUpInput | undefined,
    rentValues: number[],
    totalMonths: number,
    occupancyRamp?: OccupancyRampInput,
  ): void {
    for (const unitType of unitTypes) {
      const startingOcc = unitType.starting_occupancy_pct ?? 1;
      const stabilizedOcc = unitType.stabilized_occupancy_pct ?? startingOcc;
      const annualGrowth = unitType.annual_rent_growth_pct ?? 0;

      for (let month = 0; month < totalMonths; month += 1) {
        const occupancy = leaseUp
          ? this.leaseUpOccupancy(unitType, leaseUp, month)
          : occupancyRamp
            ? this.rampOccupancy(startingOcc, stabilizedOcc, occupancyRamp.start_month, occupancyRamp.months_to_stabilize, month)
            : startingOcc;

        const growthYears = Math.floor(month / 12);
        const monthlyRent =
          unitType.count *
          unitType.starting_rent_monthly *
          occupancy *
          Math.pow(1 + annualGrowth, growthYears);
        rentValues[month] = (rentValues[month] ?? 0) + monthlyRent;
      }
    }
  }

  private leaseUpOccupancy(unitType: UnitTypeInput, leaseUp: LeaseUpInput, month: number): number {
    const startingOcc = unitType.starting_occupancy_pct ?? 0;
    const stabilizedOcc = unitType.stabilized_occupancy_pct ?? leaseUp.stabilized_occupancy_pct;
    const startMonth = leaseUp.start_month;
    if (month < startMonth) {
      return startingOcc;
    }

    const totalUnits = unitType.count;
    const targetUnits = totalUnits * stabilizedOcc;
    const startingUnits = totalUnits * startingOcc;
    const unitsToAbsorb = Math.max(0, targetUnits - startingUnits);
    const absorption = leaseUp.absorption_units_per_month;

    if (absorption <= 0 || unitsToAbsorb === 0) {
      return stabilizedOcc;
    }

    const monthsToStabilize = Math.ceil(unitsToAbsorb / absorption);
    const elapsed = Math.min(month - startMonth, monthsToStabilize);
    const currentUnits = startingUnits + (unitsToAbsorb * elapsed) / monthsToStabilize;

    return Math.min(stabilizedOcc, currentUnits / totalUnits);
  }

  private applyMhpLotRent(lease: LeaseInput, rentValues: number[], totalMonths: number): void {
    const lotsTotal = lease.lots_total ?? 0;
    const lotsInitial = lease.lots_occupied_initial ?? lotsTotal;
    const baseRent = lease.lot_rent_monthly_initial ?? 0;
    const growthPct = lease.annual_lot_rent_growth_pct ?? 0;
    const ramp = lease.occupancy_ramp;

    for (let month = 0; month < totalMonths; month += 1) {
      const lotsOccupied = ramp
        ? this.rampUnits(lotsInitial, lotsTotal, ramp.start_month, ramp.months_to_stabilize, month)
        : lotsInitial;
      const growthYears = Math.floor(month / 12);
      const monthlyRent = lotsOccupied * baseRent * Math.pow(1 + growthPct, growthYears);
      rentValues[month] = (rentValues[month] ?? 0) + monthlyRent;
    }
  }

  private rampOccupancy(
    start: number,
    end: number,
    startMonth: number,
    monthsToStabilize: number,
    month: number,
  ): number {
    if (month < startMonth) {
      return start;
    }
    if (monthsToStabilize <= 0) {
      return end;
    }
    const elapsed = Math.min(month - startMonth, monthsToStabilize);
    return start + ((end - start) * elapsed) / monthsToStabilize;
  }

  private rampUnits(
    startUnits: number,
    endUnits: number,
    startMonth: number,
    monthsToStabilize: number,
    month: number,
  ): number {
    if (month < startMonth) {
      return startUnits;
    }
    if (monthsToStabilize <= 0) {
      return endUnits;
    }
    const elapsed = Math.min(month - startMonth, monthsToStabilize);
    return startUnits + ((endUnits - startUnits) * elapsed) / monthsToStabilize;
  }

  private monthlyRentFromBase(baseRent: { unit: BaseRentUnit; amount: number }, area: number): number {
    switch (baseRent.unit) {
      case "psf_annual":
        return (baseRent.amount * area) / 12;
      case "total_monthly":
        return baseRent.amount;
      case "total_annual":
        return baseRent.amount / 12;
      case "per_acre_annual":
        return (baseRent.amount * area) / 12;
      case "per_acre_monthly":
        return baseRent.amount * area;
      default:
        return 0;
    }
  }
}
