// Runs a stage's gates in a worktree: reads what changed since a base commit from git, runs the repository's own tests,
// type check and lint where a gate needs them, and hands the rest to the checks in src/shared/gates/model.ts.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";

import {
  check_commits,
  check_comments,
  check_coverage,
  check_dependencies,
  check_leftovers,
  check_scope,
  check_secrets,
  check_size,
  check_status,
  check_tests_kept,
  check_x_libs,
  passed,
  skipped,
  type ChangedFile,
  type Commit,
  type GateResult,
} from "../shared/gates/model.ts";

// ── Git ──────────────────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
  const result = await run_program(["git", ...args], { cwd, stdout: "keep", stderr: "keep" });
  if (result.exit_code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  return result.stdout;
}

const status_of: Record<string, ChangedFile["status"]> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified" };

// Every file changed since the base, committed or not, untracked ones included, with the lines each added.
export async function read_changes(worktree: string, base: string): Promise<ChangedFile[]> {
  const files = new Map<string, ChangedFile>();
  for (const line of (await git(["diff", "--name-status", "--find-renames", base], worktree)).split("\n").filter(Boolean)) {
    const [code = "M", ...paths] = line.split("\t");
    const path = paths.at(-1)!;
    files.set(path, { path, status: status_of[code.charAt(0)] ?? "modified", added: [] });
  }
  let current: ChangedFile | undefined;
  let next_line = 0;
  for (const line of (await git(["diff", "--unified=0", "--no-color", "--find-renames", base], worktree)).split("\n")) {
    if (line.startsWith("+++ ")) current = files.get(line.slice(6));
    else if (line.startsWith("@@")) next_line = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    else if (line.startsWith("+") && current) current.added.push({ line: next_line++, text: line.slice(1) });
  }
  for (const file of files.values()) {
    const text = file.status === "deleted" ? null : read_current(worktree, file.path);
    if (text !== null) file.first_line = text.split("\n", 1)[0];
  }
  for (const path of (await git(["ls-files", "--others", "--exclude-standard"], worktree)).split("\n").filter(Boolean)) {
    const text = readFileSync(join(worktree, path), "utf8");
    files.set(path, { path, status: "added", added: text.split("\n").map((line, index) => ({ line: index + 1, text: line })) });
  }
  return [...files.values()];
}

export async function read_commits(worktree: string, base: string): Promise<Commit[]> {
  const log = await git(["log", "--no-merges", "--format=%H%x00%B%x1e", `${base}..HEAD`], worktree);
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = "", message = ""] = entry.split("\x00");
      return { sha, message: message.trim() };
    });
}

async function file_at(worktree: string, base: string, path: string): Promise<string | null> {
  return git(["show", `${base}:${path}`], worktree).catch(() => null);
}

function read_current(worktree: string, path: string): string | null {
  const full = join(worktree, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

// ── Tools ────────────────────────────────────────────────────────────────────

interface Scripts {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifest_of(worktree: string): Scripts | null {
  const text = read_current(worktree, "package.json");
  return text === null ? null : (JSON.parse(text) as Scripts);
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

// ── Gates ────────────────────────────────────────────────────────────────────

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
}

// What git says of a checkout: its commit and any change in it.
export async function checkout_state(folder: string): Promise<string> {
  return `${(await git(["rev-parse", "HEAD"], folder)).trim()}\n${await git(["status", "--porcelain"], folder)}`;
}

// Runs the gates named, in order, giving a result for each; a gate that cannot run here says so as skipped.
export async function run_gates(gates: string[], context: GateContext): Promise<GateResult[]> {
  const files = await read_changes(context.worktree, context.base);
  const commits = await read_commits(context.worktree, context.base);
  const manifest = manifest_of(context.worktree);
  const is_org = context.repository.toLowerCase().startsWith("x-tech-laboratories/");
  const results: GateResult[] = [];

  for (const gate of gates) {
    if (gate === "report") results.push(context.report !== undefined ? passed(gate) : skipped(gate, "there is no run report here"));
    else if (gate === "status") results.push(context.status ? check_status(context.status.before, context.status.after) : skipped(gate, "there is no status sheet here"));
    else if (gate === "worktree") {
      if (!context.main_checkout) results.push(skipped(gate, "there is no main checkout to compare"));
      else results.push((await checkout_state(context.main_checkout.folder)) === context.main_checkout.before ? passed(gate) : { gate, outcome: "failed", findings: [`the main checkout at ${context.main_checkout.folder} changed during the run`] });
    } else if (gate === "scope") results.push(check_scope(files, context.paths, (path, glob) => matchesGlob(path, glob)));
    else if (gate === "tests-kept") results.push(check_tests_kept(files, context.specified_tests));
    else if (gate === "commits") results.push(check_commits(commits, is_org));
    else if (gate === "secrets") results.push(check_secrets(files, context.report ? [{ name: "report", text: context.report }] : []));
    else if (gate === "leftovers") results.push(check_leftovers(files));
    else if (gate === "comments") results.push(check_comments(files));
    else if (gate === "x-libs") results.push(check_x_libs(files, context.repository.toLowerCase().endsWith("/x-libs")));
    else if (gate === "size") {
      const counts = Object.fromEntries(files.filter((file) => file.status !== "deleted").map((file) => [file.path, (read_current(context.worktree, file.path) ?? "").split("\n").length]));
      results.push(check_size(counts));
    } else if (gate === "coverage") results.push(check_coverage(await file_at(context.worktree, context.base, "vitest.config.ts"), read_current(context.worktree, "vitest.config.ts")));
    else if (gate === "dependencies") {
      const before = await file_at(context.worktree, context.base, "package.json");
      const licence_of = (name: string) => {
        const text = read_current(context.worktree, join("node_modules", name, "package.json"));
        return text === null ? null : String((JSON.parse(text) as { license?: unknown }).license ?? "") || null;
      };
      results.push(check_dependencies(before === null ? null : JSON.parse(before), manifest, licence_of));
    } else if (gate === "tests-pass") {
      if (!has_vitest(manifest)) results.push(skipped(gate, "the repository does not test with vitest"));
      else {
        const run = await tool(["npx", "vitest", "run", "--changed", context.base, "--passWithNoTests"], context.worktree);
        results.push(run.ok ? passed(gate) : { gate, outcome: "failed", findings: ["the tests for what changed fail:", ...run.tail] });
      }
    } else if (gate === "tests-fail-first") {
      const added_tests = files.filter((file) => file.status === "added" && /\.test\.[cm]?[jt]sx?$/.test(file.path)).map((file) => file.path);
      if (!has_vitest(manifest)) results.push(skipped(gate, "the repository does not test with vitest"));
      else if (!added_tests.length) results.push({ gate, outcome: "failed", findings: ["the stage added no test files"] });
      else {
        const run = await tool(["npx", "vitest", "run", ...added_tests], context.worktree);
        results.push(run.ok ? { gate, outcome: "failed", findings: ["the new tests already pass, so they do not pin down behaviour that is missing"] } : passed(gate));
      }
    } else if (gate === "types-lint") {
      const findings: string[] = [];
      if (manifest?.scripts?.typecheck) {
        const run = await tool(["npm", "run", "--silent", "typecheck"], context.worktree);
        if (!run.ok) findings.push("the type check fails:", ...run.tail);
      }
      if (manifest?.scripts?.lint) {
        const run = await tool(["npm", "run", "--silent", "lint"], context.worktree);
        if (!run.ok) findings.push("the lint fails:", ...run.tail);
      }
      results.push(manifest?.scripts?.typecheck || manifest?.scripts?.lint ? (findings.length ? { gate, outcome: "failed", findings } : passed(gate)) : skipped(gate, "the repository has no typecheck or lint script"));
    } else if (gate === "ci") results.push(skipped(gate, "pull request checks are read once X-Dev tracks pull requests"));
    else results.push(skipped(gate, `X-Dev has no gate called ${gate}`));
  }
  return results;
}
