// The runner as a caller on another device reaches it: everything the page does, except naming the programs X-Dev starts
// and loosening how the agents' actions are approved, which only this computer's own user may change.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { RunnerMethods, RunnerSettings } from "../shared/runs/runner.ts";

// ── Runner ───────────────────────────────────────────────────────────────────

// Settings that pick what runs on this computer, and with what freedom.
export const local_only_settings: readonly (keyof RunnerSettings)[] = ["permission_mode", "claude_program", "gh_program"];

// A permission mode other than Manual lets the agent do more without asking, so it is picked only on this computer.
function refuse_looser(mode: string | undefined): void {
  if (mode && mode !== "default") throw new Error(`the ${mode} permission mode is picked only from X-Dev on the computer that runs the agents; Manual can be picked from here`);
}

export function remote_runner(runner: RunnerMethods): RunnerMethods {
  return {
    ...runner,
    start_run: (item_id, options) => {
      refuse_looser(options.mode);
      return runner.start_run(item_id, options);
    },
    retry_run: (run_id, options) => {
      refuse_looser(options.mode);
      return runner.retry_run(run_id, options);
    },
    set_run_mode: (run_id, mode) => {
      refuse_looser(mode);
      return runner.set_run_mode(run_id, mode);
    },
    answer_permission: (run_id, request_id, decision, message) => {
      if (decision === "allowed_for_run") throw new Error("a tool is allowed for the whole run only from X-Dev on the computer that runs the agents; allow this call alone from here");
      return runner.answer_permission(run_id, request_id, decision, message);
    },
    set_runner_setting: (key, value) => {
      if (local_only_settings.includes(key)) throw new Error(`${key} changes only from X-Dev on the computer that runs the agents`);
      return runner.set_runner_setting(key, value);
    },
  };
}
