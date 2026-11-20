// The permission mode for one run, picked beside its model: the stage's own unless another is picked.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";

import { page } from "../api.ts";

import { run_mode_labels, run_modes, type RunMode } from "../../shared/runs/modes.ts";

// ── Picker ───────────────────────────────────────────────────────────────────

// The modes this page may pick: every one on the computer that runs the agents, Manual alone from another device, and the
// one already in use so it still shows.
export function offered_modes(current: RunMode | "" = ""): RunMode[] {
  if (page().daemon_is_here === true) return [...run_modes];
  return run_modes.filter((mode) => mode === "default" || mode === current);
}

interface ModePickerProps {
  // The stage's own mode, empty when it follows the runner's setting.
  stage_mode: RunMode | "";
  value: RunMode | "";
  on_change: (mode: RunMode | "") => void;
}

export function ModePicker({ stage_mode, value, on_change }: ModePickerProps) {
  const as_stage = stage_mode ? `${run_mode_labels[stage_mode]}, as the stage says` : "As the runner's setting says";
  return <Select<RunMode | ""> label="Permission mode for this run" options={[["", as_stage], ...offered_modes().map((mode): [RunMode, string] => [mode, run_mode_labels[mode]])]} value={value} on_change={on_change} />;
}

// The mode as a run's options take it, left out when the stage's own is kept.
export function mode_option(mode: RunMode | ""): { mode?: RunMode } {
  return mode ? { mode } : {};
}
