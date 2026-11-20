// How a run's agent gets its tool calls approved: Auto checks each one with no one watching, Edit automatically lets
// file edits through and asks the user for the rest, and Manual asks the user for every call that is not plainly safe.
// A stage file can set its default, a run can pick its own, and the user can switch a run's mode while it works.

// ── Modes ────────────────────────────────────────────────────────────────────

// Claude Code's own names for the modes, as its --permission-mode takes them.
export const run_modes = ["auto", "acceptEdits", "default"] as const;

export type RunMode = (typeof run_modes)[number];

export const run_mode_labels: Record<RunMode, string> = { auto: "Auto", acceptEdits: "Edit automatically", default: "Manual" };

export function is_run_mode(value: unknown): value is RunMode {
  return run_modes.includes(value as RunMode);
}

// The mode a session reports in its own words, as one of the three, or empty for any other.
export function mode_of_session(mode: string): RunMode | "" {
  if (mode === "manual") return "default";
  return is_run_mode(mode) ? mode : "";
}

// The mode a run starts in: the one picked for it, else its stage's, else the runner's setting.
export function starting_mode(picked: string | undefined, stage_mode: RunMode | "", setting: string): string {
  if (is_run_mode(picked)) return picked;
  return stage_mode || setting;
}

// ── Allowing for the run ─────────────────────────────────────────────────────

// What "Allow for this run" covers: the tool, and for a command the program it starts.
export function permission_rule(tool: string, input: Record<string, unknown>): string {
  if (tool !== "Bash" || typeof input.command !== "string") return tool;
  const program = input.command.trim().split(/\s+/)[0] ?? "";
  return program ? `Bash(${program})` : tool;
}

// The rule in words for the button that sets it.
export function rule_words(rule: string): string {
  const program = /^Bash\((.+)\)$/.exec(rule)?.[1];
  return program ? `${program} commands` : rule;
}
