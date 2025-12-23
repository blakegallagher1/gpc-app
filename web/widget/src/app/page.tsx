"use client";

import { useState, useEffect, useCallback } from "react";
import { InputsView } from "@/components/InputsView";
import { ResultsView } from "@/components/ResultsView";
import { defaultInputs } from "@/lib/default-inputs";
import { validateInputs, buildModel, pollUntilComplete, extractFromNL, saveWidgetState, loadWidgetState, type WidgetState } from "@/lib/mcp-client";
import type { IndAcqInputs, ValidationResult, RunState, ExtractionResult } from "@/lib/types";

type View = "inputs" | "results";

// Deep merge extracted inputs over defaults (defined outside component to avoid hoisting issues)
function mergeInputs(base: IndAcqInputs, partial: Partial<IndAcqInputs>): IndAcqInputs {
  const result = JSON.parse(JSON.stringify(base)) as IndAcqInputs;

  const merge = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const key of Object.keys(source)) {
      const sourceVal = source[key];
      if (sourceVal === null || sourceVal === undefined) continue;

      if (typeof sourceVal === "object" && !Array.isArray(sourceVal)) {
        if (!target[key] || typeof target[key] !== "object") {
          target[key] = {};
        }
        merge(target[key] as Record<string, unknown>, sourceVal as Record<string, unknown>);
      } else {
        target[key] = sourceVal;
      }
    }
  };

  merge(result as unknown as Record<string, unknown>, partial as unknown as Record<string, unknown>);
  return result;
}

export default function IndAcqWidget() {
  const [currentView, setCurrentView] = useState<View>("inputs");
  const [inputs, setInputs] = useState<IndAcqInputs>(defaultInputs);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [runState, setRunState] = useState<RunState>({ phase: "idle" });
  const [isLoading, setIsLoading] = useState(false);
  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [nlText, setNlText] = useState("");
  const [stateLoaded, setStateLoaded] = useState(false);

  // Load persisted state from ChatGPT on mount
  useEffect(() => {
    const savedState = loadWidgetState();
    if (savedState) {
      if (savedState.inputs) {
        // Merge saved inputs over defaults to ensure structure is valid
        setInputs((prev) => mergeInputs(prev, savedState.inputs as Partial<IndAcqInputs>));
      }
      if (savedState.nlText) {
        setNlText(savedState.nlText);
      }
      if (savedState.activeView) {
        setCurrentView(savedState.activeView);
      }
      // Note: We don't restore runState as jobs may have completed
      // The user can re-run if needed; this avoids stale job state issues
    }
    setStateLoaded(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save state to ChatGPT whenever it changes
  const persistState = useCallback((state: WidgetState) => {
    saveWidgetState(state);
  }, []);

  // Persist on input changes
  useEffect(() => {
    if (!stateLoaded) return;
    persistState({
      inputs: JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>,
      nlText,
      activeView: currentView,
      jobId: runState.phase !== "idle" && "job_id" in runState ? runState.job_id : undefined,
      runPhase: runState.phase,
    });
  }, [inputs, nlText, currentView, runState, stateLoaded, persistState]);

  const handleValidate = async () => {
    setIsLoading(true);
    setValidationResult(null);

    try {
      const result = await validateInputs(inputs);
      setValidationResult(result);
    } catch (error) {
      setValidationResult({
        status: "invalid",
        errors: [{ path: "/", message: String(error) }],
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRunUnderwrite = async () => {
    setIsLoading(true);
    setValidationResult(null);
    setRunState({ phase: "validating" });

    try {
      // First validate
      const validation = await validateInputs(inputs);
      if (validation.status === "invalid") {
        setValidationResult(validation);
        setRunState({ phase: "failed", error: "Validation failed" });
        setIsLoading(false);
        return;
      }

      // Build model
      setRunState({ phase: "building" });
      const buildResult = await buildModel({ inputs, mode: "run" });

      if (buildResult.status === "failed" || buildResult.status === "needs_info" || !buildResult.job_id) {
        setRunState({
          phase: "failed",
          error: buildResult.error || "Build failed to start",
        });
        setIsLoading(false);
        return;
      }

      // Poll for completion
      setRunState({ phase: "polling", job_id: buildResult.job_id });
      setCurrentView("results");

      const finalStatus = await pollUntilComplete(
        buildResult.job_id,
        (status) => {
          if (status.status === "pending" || status.status === "running") {
            setRunState({ phase: "polling", job_id: buildResult.job_id! });
          }
        }
      );

      if (finalStatus.status === "complete") {
        setRunState({
          phase: "complete",
          job_id: finalStatus.job_id,
          outputs: finalStatus.outputs || {},
          file_path: finalStatus.file_path || null,
          download_url: finalStatus.download_url || null,
          download_url_expiry: finalStatus.download_url_expiry || null,
          warning: finalStatus.warning || null,
        });
      } else {
        setRunState({
          phase: "failed",
          error: finalStatus.error || "Job failed",
        });
      }
    } catch (error) {
      setRunState({
        phase: "failed",
        error: String(error),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRunAgain = () => {
    setRunState({ phase: "idle" });
    setCurrentView("inputs");
  };

  const handleExtractFromNL = async (description: string): Promise<ExtractionResult> => {
    setIsExtracting(true);
    setExtractionResult(null);

    try {
      const result = await extractFromNL(description);
      setExtractionResult(result);

      // If extraction succeeded (ok or needs_info with partial inputs), merge inputs
      if ((result.status === "ok" || result.status === "needs_info") && result.inputs) {
        setInputs(mergeInputs(defaultInputs, result.inputs as Partial<IndAcqInputs>));
      }

      return result;
    } catch (error) {
      const errorResult: ExtractionResult = {
        status: "failed",
        error: String(error),
      };
      setExtractionResult(errorResult);
      return errorResult;
    } finally {
      setIsExtracting(false);
    }
  };

  return (
    <main>
      {currentView === "inputs" && (
        <InputsView
          inputs={inputs}
          onInputsChange={setInputs}
          onValidate={handleValidate}
          onRunUnderwrite={handleRunUnderwrite}
          onExtractFromNL={handleExtractFromNL}
          validationResult={validationResult}
          extractionResult={extractionResult}
          isLoading={isLoading}
          isExtracting={isExtracting}
          nlText={nlText}
          onNlTextChange={setNlText}
        />
      )}

      {currentView === "results" && (
        <ResultsView runState={runState} onRunAgain={handleRunAgain} />
      )}
    </main>
  );
}
