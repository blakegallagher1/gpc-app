"use client";

import { useState } from "react";
import type { IndAcqInputs, Tenant, ValidationResult } from "@/lib/types";

interface Props {
  inputs: IndAcqInputs;
  onInputsChange: (inputs: IndAcqInputs) => void;
  onValidate: () => Promise<void>;
  onRunUnderwrite: () => Promise<void>;
  validationResult: ValidationResult | null;
  isLoading: boolean;
}

export function InputsView({
  inputs,
  onInputsChange,
  onValidate,
  onRunUnderwrite,
  validationResult,
  isLoading,
}: Props) {
  const [expandedSection, setExpandedSection] = useState<string | null>("deal");

  const updateField = (path: string, value: unknown) => {
    const parts = path.split(".");
    const newInputs = JSON.parse(JSON.stringify(inputs)) as IndAcqInputs;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = newInputs;

    for (let i = 0; i < parts.length - 1; i++) {
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    onInputsChange(newInputs);
  };

  const updateTenant = (index: number, field: keyof Tenant, value: unknown) => {
    const newTenants = [...inputs.rent_roll.tenants_in_place];
    newTenants[index] = { ...newTenants[index], [field]: value };
    updateField("rent_roll.tenants_in_place", newTenants);
  };

  const addTenant = () => {
    const newTenant: Tenant = {
      tenant_name: "New Tenant",
      sf: 1000,
      lease_start: inputs.deal.analysis_start_date,
      lease_end: "2030-12-31",
      current_rent_psf_annual: 15,
      annual_bump_pct: 0.02,
      lease_type: "NNN",
    };
    updateField("rent_roll.tenants_in_place", [
      ...inputs.rent_roll.tenants_in_place,
      newTenant,
    ]);
  };

  const removeTenant = (index: number) => {
    const newTenants = inputs.rent_roll.tenants_in_place.filter(
      (_, i) => i !== index
    );
    updateField("rent_roll.tenants_in_place", newTenants);
  };

  const toggleSection = (section: string) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  const formatPercent = (value: number) => (value * 100).toFixed(2);
  const parsePercent = (value: string) => parseFloat(value) / 100;

  return (
    <div className="inputs-view">
      <h2>IND_ACQ Underwriting Inputs</h2>

      {validationResult && validationResult.status === "invalid" && (
        <div className="validation-errors">
          <h4>Validation Errors:</h4>
          <ul>
            {validationResult.errors?.map((err, i) => (
              <li key={i}>
                <strong>{err.path}:</strong> {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {validationResult && validationResult.status === "ok" && (
        <div className="validation-success">Inputs validated successfully</div>
      )}

      {/* Deal Section */}
      <section className="input-section">
        <h3 onClick={() => toggleSection("deal")} className="section-header">
          Deal Information {expandedSection === "deal" ? "▼" : "▶"}
        </h3>
        {expandedSection === "deal" && (
          <div className="section-content">
            <div className="form-row">
              <label>Project Name</label>
              <input
                type="text"
                value={inputs.deal.project_name}
                onChange={(e) => updateField("deal.project_name", e.target.value)}
              />
            </div>
            <div className="form-row-group">
              <div className="form-row">
                <label>City</label>
                <input
                  type="text"
                  value={inputs.deal.city}
                  onChange={(e) => updateField("deal.city", e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>State</label>
                <input
                  type="text"
                  value={inputs.deal.state}
                  onChange={(e) => updateField("deal.state", e.target.value)}
                  maxLength={2}
                />
              </div>
            </div>
            <div className="form-row-group">
              <div className="form-row">
                <label>Analysis Start Date</label>
                <input
                  type="date"
                  value={inputs.deal.analysis_start_date}
                  onChange={(e) =>
                    updateField("deal.analysis_start_date", e.target.value)
                  }
                />
              </div>
              <div className="form-row">
                <label>Hold Period (months)</label>
                <input
                  type="number"
                  value={inputs.deal.hold_period_months}
                  onChange={(e) =>
                    updateField("deal.hold_period_months", parseInt(e.target.value))
                  }
                />
              </div>
            </div>
            <div className="form-row">
              <label>Net SF</label>
              <input
                type="number"
                value={inputs.deal.net_sf}
                onChange={(e) =>
                  updateField("deal.net_sf", parseInt(e.target.value))
                }
              />
            </div>
          </div>
        )}
      </section>

      {/* Acquisition Section */}
      <section className="input-section">
        <h3 onClick={() => toggleSection("acquisition")} className="section-header">
          Acquisition {expandedSection === "acquisition" ? "▼" : "▶"}
        </h3>
        {expandedSection === "acquisition" && (
          <div className="section-content">
            <div className="form-row">
              <label>Purchase Price ($)</label>
              <input
                type="number"
                value={inputs.acquisition.purchase_price}
                onChange={(e) =>
                  updateField("acquisition.purchase_price", parseInt(e.target.value))
                }
              />
            </div>
          </div>
        )}
      </section>

      {/* Operating Section */}
      <section className="input-section">
        <h3 onClick={() => toggleSection("operating")} className="section-header">
          Operating {expandedSection === "operating" ? "▼" : "▶"}
        </h3>
        {expandedSection === "operating" && (
          <div className="section-content">
            <div className="form-row-group">
              <div className="form-row">
                <label>Vacancy (%)</label>
                <input
                  type="number"
                  step="0.01"
                  value={formatPercent(inputs.operating.vacancy_pct)}
                  onChange={(e) =>
                    updateField("operating.vacancy_pct", parsePercent(e.target.value))
                  }
                />
              </div>
              <div className="form-row">
                <label>Mgmt Fee (% EGI)</label>
                <input
                  type="number"
                  step="0.01"
                  value={formatPercent(inputs.operating.expenses.management_fee_pct_egi)}
                  onChange={(e) =>
                    updateField(
                      "operating.expenses.management_fee_pct_egi",
                      parsePercent(e.target.value)
                    )
                  }
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Debt Section */}
      <section className="input-section">
        <h3 onClick={() => toggleSection("debt")} className="section-header">
          Debt {expandedSection === "debt" ? "▼" : "▶"}
        </h3>
        {expandedSection === "debt" && (
          <div className="section-content">
            <div className="form-row-group">
              <div className="form-row">
                <label>Max LTV (%)</label>
                <input
                  type="number"
                  step="0.01"
                  value={formatPercent(inputs.debt.acquisition_loan.ltv_max)}
                  onChange={(e) =>
                    updateField(
                      "debt.acquisition_loan.ltv_max",
                      parsePercent(e.target.value)
                    )
                  }
                />
              </div>
              <div className="form-row">
                <label>Fixed Rate (%)</label>
                <input
                  type="number"
                  step="0.01"
                  value={formatPercent(inputs.debt.acquisition_loan.rate.fixed_rate)}
                  onChange={(e) =>
                    updateField(
                      "debt.acquisition_loan.rate.fixed_rate",
                      parsePercent(e.target.value)
                    )
                  }
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Exit Section */}
      <section className="input-section">
        <h3 onClick={() => toggleSection("exit")} className="section-header">
          Exit {expandedSection === "exit" ? "▼" : "▶"}
        </h3>
        {expandedSection === "exit" && (
          <div className="section-content">
            <div className="form-row-group">
              <div className="form-row">
                <label>Exit Month</label>
                <input
                  type="number"
                  value={inputs.exit.exit_month}
                  onChange={(e) =>
                    updateField("exit.exit_month", parseInt(e.target.value))
                  }
                />
              </div>
              <div className="form-row">
                <label>Exit Cap Rate (%)</label>
                <input
                  type="number"
                  step="0.01"
                  value={formatPercent(inputs.exit.exit_cap_rate)}
                  onChange={(e) =>
                    updateField("exit.exit_cap_rate", parsePercent(e.target.value))
                  }
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Rent Roll Section */}
      <section className="input-section">
        <h3 onClick={() => toggleSection("rentroll")} className="section-header">
          Rent Roll - In Place {expandedSection === "rentroll" ? "▼" : "▶"}
        </h3>
        {expandedSection === "rentroll" && (
          <div className="section-content">
            <table className="rent-roll-table">
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>SF</th>
                  <th>Lease Start</th>
                  <th>Lease End</th>
                  <th>Rent PSF</th>
                  <th>Bump %</th>
                  <th>Type</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {inputs.rent_roll.tenants_in_place.map((tenant, idx) => (
                  <tr key={idx}>
                    <td>
                      <input
                        type="text"
                        value={tenant.tenant_name}
                        onChange={(e) =>
                          updateTenant(idx, "tenant_name", e.target.value)
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={tenant.sf}
                        onChange={(e) =>
                          updateTenant(idx, "sf", parseInt(e.target.value))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        value={tenant.lease_start}
                        onChange={(e) =>
                          updateTenant(idx, "lease_start", e.target.value)
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        value={tenant.lease_end}
                        onChange={(e) =>
                          updateTenant(idx, "lease_end", e.target.value)
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        value={tenant.current_rent_psf_annual}
                        onChange={(e) =>
                          updateTenant(
                            idx,
                            "current_rent_psf_annual",
                            parseFloat(e.target.value)
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        value={formatPercent(tenant.annual_bump_pct)}
                        onChange={(e) =>
                          updateTenant(
                            idx,
                            "annual_bump_pct",
                            parsePercent(e.target.value)
                          )
                        }
                      />
                    </td>
                    <td>
                      <select
                        value={tenant.lease_type}
                        onChange={(e) =>
                          updateTenant(idx, "lease_type", e.target.value)
                        }
                      >
                        <option value="NNN">NNN</option>
                        <option value="GROSS">Gross</option>
                        <option value="MODIFIED_GROSS">Modified Gross</option>
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-delete"
                        onClick={() => removeTenant(idx)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="btn-add" onClick={addTenant}>
              + Add Tenant
            </button>
          </div>
        )}
      </section>

      {/* Action Buttons */}
      <div className="action-buttons">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onValidate}
          disabled={isLoading}
        >
          {isLoading ? "..." : "Validate"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onRunUnderwrite}
          disabled={isLoading}
        >
          {isLoading ? "Running..." : "Run Underwrite"}
        </button>
      </div>
    </div>
  );
}
