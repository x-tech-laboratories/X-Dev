// The runner as a caller on another device reaches it: everything the page does, except naming the programs X-Dev starts
// and loosening how the agents' actions are approved, which only this computer's own user may change.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { RunnerMethods, RunnerSettings } from "../shared/runs/runner.ts";

// ── Runner ───────────────────────────────────────────────────────────────────

// Settings that pick what runs on this computer, and with what freedom.
export const local_only_settings: readonly (keyof RunnerSettings)[] = ["permission_mode", "claude_program", "gh_program"];

export function remote_runner(runner: RunnerMethods): RunnerMethods {
  return {
    ...runner,
    set_runner_setting: (key, value) => {
      if (local_only_settings.includes(key)) throw new Error(`${key} changes only from X-Dev on the computer that runs the agents`);
      return runner.set_runner_setting(key, value);
    },
  };
}
