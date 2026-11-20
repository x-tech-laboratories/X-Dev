// Runs a stage's gates in a worktree: reads what changed since a base commit from git through X-Libs, runs the
// repository's own tests, type check and lint where a gate needs them, and hands the rest to the change checks.

// ── Imports ──────────────────────────────────────────────────────────────────

import { matchesGlob } from "node:path";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";
import { create_check_registry, type Change, type CheckRegistry } from "@x-tech-laboratories/x-libs/change_checks";
import { options_from_manifest } from "@x-tech-laboratories/x-libs/change_checks_cli";
import { read_change } from "@x-tech-laboratories/x-libs/change_checks_git";

import { check_ci, check_scope, check_size, check_status, check_tests_kept, passed, skipped, type GateResult } from "../shared/gates/model.ts";
import { find_pull_request, read_checks } from "./github.ts";

// ── Git ──────────────────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
  const result = await run_program(["git", ...args], { cwd, stdout: "keep", stderr: "keep" });
  if (result.exit_code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  return result.stdout;
}

// ── Tools ────────────────────────────────────────────────────────────────────

interface Scripts {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifest_of(change: Change): Scripts | null {
  return change.package_json.after === null ? null : (JSON.parse(change.package_json.after) as Scripts);
}

const shown_output_lines = 15;

async function tool(argv: string[], worktree: string): Promise<{ ok: boolean; tail: string[] }> {
  const result = await run_program(argv, { cwd: worktree, stdout: "keep", stderr: "keep" });
  const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").filter(Boolean).slice(-shown_output_lines);
  return { ok: result.exit_code === 0, tail };
}

function has_vitest(manifest: Scripts | null): boolean {
  return Boolean(manifest?.devDependencies?.vitest ?? manifest?.dependencies?.vitest);
}

// ── Context ──────────────────────────────────────────────────────────────────

export interface GateContext {
  worktree: string;
  // The commit the run started from, or the branch point for x-dev-check.
  base: string;
  repository: string;
  // What the stage may change; empty for anything.
  paths: string[];
  // Test files earlier Specify runs added, which later stages may not change.
  specified_tests: string[];
  // The status sheet before and after, for the status gate; left out by x-dev-check.
  status?: { before: string; after: string };
  report?: string;
  // The repository's own checkout and what git said of it before the run, for the worktree gate.
  main_checkout?: { folder: string; before: string };
  // The gh program the ci gate reads the pull request through; without it the gate is not checked.
  gh_program?: string;
}

// What git says of a checkout: its commit and any change in it.
export async function checkout_state(folder: string): Promise<string> {
  return `${(await git(["rev-parse", "HEAD"], folder)).trim()}\n${await git(["status", "--porcelain"], folder)}`;
}

// ── X-Dev's gates ────────────────────────────────────────────────────────────

type XDevGate = (change: Change, context: GateContext) => GateResult | Promise<GateResult>;

// The ci gate: the checks of the pull request from the worktree's branch, read through gh.
async function ci_gate(context: GateContext): Promise<GateResult> {
  if (!context.gh_program) return skipped("ci", "pull request checks are read by X-Dev's runner, not here");
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], context.worktree)).trim();
  if (branch === "HEAD") return skipped("ci", "the worktree is on no branch");
  try {
    const found = await find_pull_request(context.repository, branch, context.gh_program);
    const checks = found?.state === "open" ? await read_checks(context.repository, found.number, context.gh_program) : [];
    return check_ci(found && { ...found, checks, changed_at: "" });
  } catch (error) {
    return { gate: "ci", outcome: "failed", findings: [`GitHub could not be reached (${error instanceof Error ? error.message : String(error)}); Sync to GitHub on the item checks again`] };
  }
}

async function worktree_gate(context: GateContext): Promise<GateResult> {
  if (!context.main_checkout) return skipped("worktree", "there is no main checkout to compare");
  if ((await checkout_state(context.main_checkout.folder)) === context.main_checkout.before) return passed("worktree");
  return { gate: "worktree", outcome: "failed", findings: [`the main checkout at ${context.main_checkout.folder} changed during the run`] };
}

async function tests_pass_gate(change: Change, context: GateContext): Promise<GateResult> {
  if (!has_vitest(manifest_of(change))) return skipped("tests-pass", "the repository does not test with vitest");
  const run = await tool(["npx", "vitest", "run", "--changed", context.base, "--passWithNoTests"], context.worktree);
  return run.ok ? passed("tests-pass") : { gate: "tests-pass", outcome: "failed", findings: ["the tests for what changed fail:", ...run.tail] };
}

async function tests_fail_first_gate(change: Change, context: GateContext): Promise<GateResult> {
  const added_tests = change.files.filter((file) => file.status === "added" && /\.test\.[cm]?[jt]sx?$/.test(file.path)).map((file) => file.path);
  if (!has_vitest(manifest_of(change))) return skipped("tests-fail-first", "the repository does not test with vitest");
  if (!added_tests.length) return { gate: "tests-fail-first", outcome: "failed", findings: ["the stage added no test files"] };
  const run = await tool(["npx", "vitest", "run", ...added_tests], context.worktree);
  return run.ok ? { gate: "tests-fail-first", outcome: "failed", findings: ["the new tests already pass, so they do not pin down behaviour that is missing"] } : passed("tests-fail-first");
}

async function types_lint_gate(change: Change, context: GateContext): Promise<GateResult> {
  const scripts = manifest_of(change)?.scripts;
  if (!scripts?.typecheck && !scripts?.lint) return skipped("types-lint", "the repository has no typecheck or lint script");
  const findings: string[] = [];
  if (scripts.typecheck) {
    const run = await tool(["npm", "run", "--silent", "typecheck"], context.worktree);
    if (!run.ok) findings.push("the type check fails:", ...run.tail);
  }
  if (scripts.lint) {
    const run = await tool(["npm", "run", "--silent", "lint"], context.worktree);
    if (!run.ok) findings.push("the lint fails:", ...run.tail);
  }
  return findings.length ? { gate: "types-lint", outcome: "failed", findings } : passed("types-lint");
}

const x_dev_gates: Record<string, XDevGate> = {
  report: (_change, context) => (context.report !== undefined ? passed("report") : skipped("report", "there is no run report here")),
  status: (_change, context) => (context.status ? check_status(context.status.before, context.status.after) : skipped("status", "there is no status sheet here")),
  worktree: (_change, context) => worktree_gate(context),
  scope: (change, context) => check_scope(change.files, context.paths, (path, glob) => matchesGlob(path, glob)),
  "tests-kept": (change, context) => check_tests_kept(change.files, context.specified_tests),
  size: (change) => check_size(Object.fromEntries(change.files.filter((file) => file.text !== undefined).map((file) => [file.path, file.text!.split("\n").length]))),
  "tests-pass": tests_pass_gate,
  "tests-fail-first": tests_fail_first_gate,
  "types-lint": types_lint_gate,
  ci: (_change, context) => ci_gate(context),
};

// ── Running ──────────────────────────────────────────────────────────────────

// The X-Libs change checks with X-Dev's own gates added, each bound to the run's context.
export function gate_registry(context: GateContext): CheckRegistry {
  const registry = create_check_registry();
  for (const [name, gate] of Object.entries(x_dev_gates)) registry.add(name, (change) => gate(change, context));
  return registry;
}

// Runs the gates named, in order, giving a result for each; a gate that cannot run here says so as skipped.
export async function run_gates(gates: string[], context: GateContext): Promise<GateResult[]> {
  const change = await read_change(context.worktree, context.base, { working_tree: true, repository: context.repository });
  if (context.report) change.texts = [{ name: "report", text: context.report }];
  const options = options_from_manifest(change.package_json.before ?? change.package_json.after);
  return gate_registry(context).run(gates, change, options);
}
