// The words the item pages and the board share for a run's state and a stage's name.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Tone } from "@x-tech-laboratories/x-libs/web/react/badges";

import type { RunState } from "../../shared/runs/model.ts";
import { done, type Stage } from "../../shared/stages/model.ts";

// ── Words ────────────────────────────────────────────────────────────────────

export const run_state_labels: Record<RunState, [string, Tone]> = {
  running: ["Running", "info"],
  waiting: ["Waiting for answers", "warn"],
  done: ["Done", "good"],
  failed: ["Failed", "bad"],
  stopped: ["Stopped", "none"],
  discarded: ["Discarded", "none"],
};

export function stage_label(stages: Stage[], id: string): string {
  if (id === done) return "Done";
  if (id === "proposed") return "Proposed";
  if (id === "needs-input") return "Needs input";
  return stages.find((stage) => stage.id === id)?.label ?? id;
}
