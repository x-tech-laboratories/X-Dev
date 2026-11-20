#!/usr/bin/env node
// x-dev-check: runs the X-Libs change checks and X-Dev's own gates on a checkout's changes since a base, so a
// repository's CI holds every change to the same checks a stage's run meets, whether X-Dev made it or not.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_check_command, type CheckCommandContext } from "@x-tech-laboratories/x-libs/change_checks_cli";

import { gate_registry } from "../server/gates.ts";

// ── Options ──────────────────────────────────────────────────────────────────

// The gates that need nothing but the change itself, run when none are named.
export const default_gates = ["commits", "secrets", "leftovers", "comments", "coverage", "x-libs", "dependencies", "size"];

// ── Run ──────────────────────────────────────────────────────────────────────

// Runs x-dev-check with its arguments and answers the exit code: 0 when nothing failed, 1 when a gate failed, 2 when misused.
export async function run_x_dev_check(args: string[], context: Omit<CheckCommandContext, "registry">): Promise<number> {
  const registry = gate_registry({ worktree: context.cwd, base: "", repository: "", paths: [], specified_tests: [] });
  return run_check_command(args, { ...context, registry, default_checks: default_gates, command_name: "x-dev-check" });
}

if (import.meta.main) {
  process.exit(await run_x_dev_check(process.argv.slice(2), { cwd: process.cwd(), env: process.env, out: process.stdout, err: process.stderr }));
}
