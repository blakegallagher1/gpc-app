Deal Engine V0 Contract

Overview

Deal Engine V0 is the unified schema for CRE financial modeling across all asset classes.

Structure

{
  "contract": { ... },      // Version + template selection
  "deal": { ... },          // Project metadata + timeline
  "asset": { ... },         // Physical asset attributes
  "acquisition": { ... },   // Purchase terms
  "modules": { ... }        // Modular computation inputs
}

Module Types

| Module      | Purpose                          |
|-------------|----------------------------------|
| lease       | Rent roll / unit mix / lot rent  |
| operating   | Vacancy, expenses, inflation     |
| capex       | One-time capital expenditures    |
| development | Construction + lease-up timeline |
| debt        | Loans, refinance events          |
| portfolio   | Multi-asset aggregation          |
| fund        | Closed-end fund terms + fees     |
| equity      | GP/LP parties + waterfall        |
| exit        | Sale timing + cap rate           |
| scenario    | Sensitivity grids                |

Lease Modes

- commercial_rent_roll: SF/acre-based tenants
- multifamily_unit_mix: Unit types with rent + occupancy
- storage_unit_mix: Storage units with occupancy ramp
- mhp_lot_rent: Mobile home park lot rents

Template Selection

The contract.template_id determines which modules are required.
See template_library_v1.json for the full mapping.
