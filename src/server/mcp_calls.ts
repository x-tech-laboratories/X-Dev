// Every control of X-Dev as an MCP tool, on the server and on the desktop daemon's local endpoint alike: the data
// calls, the stage files and, where agents run, the runner, each from its own spec.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { MethodSpec } from "@x-tech-laboratories/x-libs/api_spec";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { dev_bridge, runner_bridge, stages_bridge } from "../shared/bridge.ts";
import { without_secrets } from "../shared/mcp.ts";
import { runner_api } from "../shared/runs/api.ts";
import type { RunnerMethods } from "../shared/runs/runner.ts";
import { stages_api } from "../shared/stages/api.ts";
import type { StagesMethods } from "../shared/stages/model.ts";
import { bind_methods, dev_api, is_read_only } from "../shared/store.ts";
import { remote_runner } from "./remote_runner.ts";

// ── Tools ────────────────────────────────────────────────────────────────────

// The tools offered: the runner's only where agents run.
export function mcp_api(has_runner: boolean): Record<string, MethodSpec> {
  return { ...dev_api, ...stages_api, ...(has_runner ? runner_api : {}) };
}

// Whether a tool reaches the stage files or the runner, which only an admin may use.
export function is_admin_tool(method: string): boolean {
  return method in stages_api || method in runner_api;
}

export interface McpCallOptions {
  database: () => SqlDatabase;
  // Tells every page and device of a change, since no page made it.
  announce: () => void;
  stages: StagesMethods;
  runner?: RunnerMethods | undefined;
}

// Runs one tool; the runner goes through the same refusals as any caller from elsewhere.
export function create_mcp_call({ database, announce, stages, runner }: McpCallOptions): (method: string, args: unknown[]) => Promise<unknown> {
  const guarded_runner = runner && remote_runner(runner);
  return async (method, args) => {
    if (method in runner_api && guarded_runner) {
      const result = await runner_bridge.dispatch(guarded_runner, method, args);
      if (!is_read_only(method)) announce();
      return result;
    }
    if (method in stages_api) {
      const result = await stages_bridge.dispatch(stages, method, args);
      if (!is_read_only(method)) announce();
      return result;
    }
    return without_secrets(method, await dev_bridge.dispatch(bind_methods(database, announce), method, args));
  };
}
