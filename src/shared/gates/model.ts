// The gates: checks X-Dev runs itself after a stage, not left to the agent. Each check here works on what changed,
// already read from git, so the runner and the x-dev-check command share them and the tests need no repository.

// ── Imports ──────────────────────────────────────────────────────────────────

import { code_file, passed, skipped, type ChangedFile, type GateResult } from "@x-tech-laboratories/x-libs/change_checks";

import type { PullRequest } from "../items/github.ts";

// ── Shared checks ────────────────────────────────────────────────────────────

// The checks every X-app's CI runs come from X-Libs; the rest of this file is X-Dev's own.
export {
  check_commits,
  check_comments,
  check_coverage,
  check_dependencies,
  check_leftovers,
  check_secrets,
  check_x_libs,
  code_file,
  code_only,
  passed,
  read_thresholds,
  skipped,
  type ChangedFile,
  type Commit,
  type GateOutcome,
  type GateResult,
} from "@x-tech-laboratories/x-libs/change_checks";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface GateOverride {
  gate: string;
  reason: string;
}

function verdict(gate: string, findings: string[], outcome: "failed" | "warning" = "failed"): GateResult {
  return findings.length ? { gate, outcome, findings } : passed(gate);
}

// Whether every failed gate has an override, so the run can hand its report on.
export function gates_cleared(results: GateResult[], overrides: GateOverride[]): boolean {
  return results.every((result) => result.outcome !== "failed" || overrides.some((override) => override.gate === result.gate));
}

// ── Scope ────────────────────────────────────────────────────────────────────

// Files the stage changed outside the paths it may touch; any path is allowed when none are given.
export function check_scope(files: ChangedFile[], paths: string[], matches: (path: string, glob: string) => boolean): GateResult {
  if (!paths.length) return passed("scope");
  const outside = files.filter((file) => !paths.some((glob) => matches(file.path, glob)));
  return verdict("scope", outside.map((file) => `${file.path} is outside what this stage may change (${paths.join(", ")})`));
}

// ── Tests ────────────────────────────────────────────────────────────────────

const test_focus = /\b(?:it|test|describe)\.(?:only|skip)\(|\bx(?:it|describe)\(/;

// Specify's tests changed, deleted, skipped or focused by a later stage.
export function check_tests_kept(files: ChangedFile[], specified: string[]): GateResult {
  const findings: string[] = [];
  for (const file of files) {
    if (specified.includes(file.path) && file.status !== "added") findings.push(`${file.path} is one of Specify's tests and was ${file.status === "deleted" ? "deleted" : "changed"}`);
    for (const added of file.added) if (test_focus.test(added.text)) findings.push(`${file.path}:${added.line} skips or focuses a test`);
  }
  return verdict("tests-kept", findings);
}

// ── Size ─────────────────────────────────────────────────────────────────────

export const most_file_lines = 500;

// Changed files grown past a length a reader can hold in their head; a warning for Review, not a failure.
export function check_size(line_counts: Record<string, number>): GateResult {
  const long = Object.entries(line_counts).filter(([path, count]) => code_file.test(path) && count > most_file_lines);
  return verdict("size", long.map(([path, count]) => `${path} is ${count} lines long, over ${most_file_lines}`), "warning");
}

// ── Status sheet ─────────────────────────────────────────────────────────────

// Whether the run brought the status sheet up to date.
export function check_status(before: string, after: string): GateResult {
  return before === after ? { gate: "status", outcome: "failed", findings: ["the run did not update the status sheet"] } : passed("status");
}

// ── Pull request checks ──────────────────────────────────────────────────────

// Whether the pull request's checks pass; none open for the branch is not checked, and checks still running hold it.
export function check_ci(pull_request: PullRequest | null): GateResult {
  if (!pull_request) return skipped("ci", "no pull request is open for the branch");
  if (pull_request.state === "closed") return { gate: "ci", outcome: "failed", findings: [`pull request #${pull_request.number} was closed without merging`] };
  if (!pull_request.checks.length) return skipped("ci", `pull request #${pull_request.number} has no checks`);
  const failed = pull_request.checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
  if (failed.length) return { gate: "ci", outcome: "failed", findings: failed.map((check) => `${check.workflow ? `${check.workflow} / ` : ""}${check.name} ${check.bucket === "fail" ? "failed" : "was cancelled"}`) };
  const pending = pull_request.checks.filter((check) => check.bucket === "pending");
  if (pending.length) return { gate: "ci", outcome: "failed", findings: [`still running: ${pending.map((check) => check.name).join(", ")}; X-Dev checks again when they finish`] };
  return passed("ci");
}
