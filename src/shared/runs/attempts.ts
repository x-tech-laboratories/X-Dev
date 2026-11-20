// Retrying a stage: which ended runs may be retried, and what the retry's agent is told of the attempt before it, so it
// fixes forward from where that one stopped rather than starting blind.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Run } from "./model.ts";

// ── Rules ────────────────────────────────────────────────────────────────────

// The failed gates the user has not passed over.
function failed_gates(run: Pick<Run, "gates" | "overrides">): Run["gates"] {
  return run.gates.filter((gate) => gate.outcome === "failed" && !run.overrides.some((override) => override.gate === gate.gate));
}

// Whether the run is held only by pull request checks still running, which clears by itself once they finish.
export function waits_on_checks(run: Pick<Run, "state" | "gates" | "overrides">): boolean {
  const failed = failed_gates(run);
  return run.state === "failed" && failed.length > 0 && failed.every((gate) => gate.gate === "ci" && gate.findings.some((finding) => finding.startsWith("still running")));
}

// Whether a run ended in a way another attempt can fix: failed, held by a gate, or stopped.
export function can_retry(run: Pick<Run, "state" | "gates" | "overrides">): boolean {
  return (run.state === "failed" || run.state === "stopped") && !waits_on_checks(run);
}

// ── Input ────────────────────────────────────────────────────────────────────

const ending_words: Partial<Record<Run["state"], string>> = { failed: "It failed.", stopped: "The user stopped it before it finished." };

// What the retry's agent is told of the attempt before it: how it ended, why, and its report; never its transcript.
export function previous_attempt_section(run: Pick<Run, "state" | "error" | "gates" | "overrides" | "report">): string {
  const gates = failed_gates(run);
  const lines = ["## Previous attempt", "", `This stage ran before on this item and did not finish. ${ending_words[run.state] ?? ""} The worktree is as that attempt left it; carry on from there and fix what went wrong.`.trim()];
  if (gates.length) {
    lines.push("", "Gates that failed:");
    for (const gate of gates) lines.push(`- ${gate.gate}: ${gate.findings.join("; ") || "no findings given"}`);
  } else if (run.error) {
    lines.push("", `What went wrong: ${run.error.split("\n")[0]}`);
  }
  if (run.report) lines.push("", "Its report:", "", run.report);
  return lines.join("\n");
}
