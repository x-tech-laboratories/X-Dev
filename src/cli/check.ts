#!/usr/bin/env node
// x-dev-check: runs the X-Libs change checks and X-Dev's own gates on a checkout's changes since a base, so a
// repository's CI holds every change to the same checks a stage's run meets, whether X-Dev made it or not.

// ── Imports ──────────────────────────────────────────────────────────────────

import { parseArgs } from "node:util";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";
import { run_check_command, type CheckCommandContext } from "@x-tech-laboratories/x-libs/change_checks_cli";

import { gate_registry } from "../server/gates.ts";

// ── Options ──────────────────────────────────────────────────────────────────

// The gates that need nothing but the change itself, run when none are named.
export const default_gates = ["commits", "secrets", "leftovers", "comments", "coverage", "x-libs", "dependencies", "size"];

const known_options = { base: { type: "string" }, repository: { type: "string" }, "working-tree": { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;

// The arguments with the base made explicit, so X-Dev's gates and the change read agree on it, and the default gates added when none are named.
export async function complete_arguments(args: string[], cwd: string): Promise<{ args: string[]; base: string }> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: false, options: known_options });
  const completed = values.help || positionals.length ? [...args] : [...args, ...default_gates];
  if (typeof values.base === "string") return { args: completed, base: values.base };
  const merge_base = await run_program(["git", "merge-base", "origin/main", "HEAD"], { cwd, stdout: "keep", stderr: "keep" });
  const base = merge_base.exit_code === 0 ? merge_base.stdout.trim() : "";
  return { args: base ? ["--base", base, ...completed] : completed, base };
}

// ── Run ──────────────────────────────────────────────────────────────────────

// Runs x-dev-check with its arguments and answers the exit code: 0 when nothing failed, 1 when a gate failed, 2 when misused.
export async function run_x_dev_check(args: string[], context: Omit<CheckCommandContext, "registry">): Promise<number> {
  const completed = await complete_arguments(args, context.cwd);
  const registry = gate_registry({ worktree: context.cwd, base: completed.base, repository: "", paths: [], specified_tests: [] });
  return run_check_command(completed.args, { ...context, registry });
}

if (import.meta.main) {
  process.exit(await run_x_dev_check(process.argv.slice(2), { cwd: process.cwd(), env: process.env, out: process.stdout, err: process.stderr }));
}
