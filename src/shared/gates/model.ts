// The gates: checks X-Dev runs itself after a stage, not left to the agent. Each check here works on what changed,
// already read from git, so the runner and the x-dev-check command share them and the tests need no repository.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PullRequest } from "../items/github.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type GateOutcome = "passed" | "failed" | "warning" | "skipped";

export interface GateResult {
  gate: string;
  outcome: GateOutcome;
  // What it found, one line each, such as "src/a.ts:12 logs to the console".
  findings: string[];
}

export interface GateOverride {
  gate: string;
  reason: string;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  // The lines the change added, each with its line number in the new file.
  added: { line: number; text: string }[];
  // The file's first line, when the change did not add it, so a #! above the change is still seen.
  first_line?: string;
}

export interface Commit {
  sha: string;
  message: string;
}

export function passed(gate: string): GateResult {
  return { gate, outcome: "passed", findings: [] };
}

export function skipped(gate: string, why: string): GateResult {
  return { gate, outcome: "skipped", findings: [why] };
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

// ── Commits ──────────────────────────────────────────────────────────────────

const conventional = /^(feat|fix|build|chore|ci|docs|style|refactor|perf|test|revert)(\([^)]+\))?!?: \S/;
const ai_mention = /\b(claude|anthropic|co-authored-by|generated with|ai[- ]generated|chatgpt|copilot)\b/i;
const assisted_trailer = /^Assisted-by: .+$/m;

// Conventional Commits; in an X-Tech Laboratories repository an Assisted-by trailer and no other AI mention, elsewhere none.
export function check_commits(commits: Commit[], needs_trailer: boolean): GateResult {
  const findings: string[] = [];
  for (const commit of commits) {
    const [subject = ""] = commit.message.split("\n");
    const short = commit.sha.slice(0, 7);
    if (!conventional.test(subject)) findings.push(`${short} "${subject}" is not a Conventional Commit`);
    const without_trailer = commit.message.replace(assisted_trailer, "");
    if (needs_trailer && !assisted_trailer.test(commit.message)) findings.push(`${short} has no Assisted-by trailer`);
    if (!needs_trailer && assisted_trailer.test(commit.message)) findings.push(`${short} has an Assisted-by trailer, which only X-Tech Laboratories repositories carry`);
    if (ai_mention.test(without_trailer)) findings.push(`${short} mentions AI outside the trailer`);
  }
  return verdict("commits", findings);
}

// ── Secrets ──────────────────────────────────────────────────────────────────

const secret_patterns: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic key"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\b(?:password|passwd|secret|api_key|apikey|token)\s*[:=]\s*["'](?![^"']*\$\{)[^"'\s]{8,}["']/i, "a password or token in the code"],
];

// Keys, tokens and private keys in the lines a change added, and .env files it added.
export function check_secrets(files: ChangedFile[], extra_texts: { name: string; text: string }[] = []): GateResult {
  const findings: string[] = [];
  for (const file of files) {
    if (/(^|\/)\.env(\.|$)/.test(file.path) && file.status !== "deleted" && !file.path.endsWith(".example")) findings.push(`${file.path} is an environment file, which keeps secrets`);
    for (const added of file.added) {
      const found = secret_patterns.find(([pattern]) => pattern.test(added.text));
      if (found) findings.push(`${file.path}:${added.line} holds ${found[1]}`);
    }
  }
  for (const extra of extra_texts) {
    const found = secret_patterns.find(([pattern]) => pattern.test(extra.text));
    if (found) findings.push(`the ${extra.name} holds ${found[1]}`);
  }
  return verdict("secrets", findings);
}

// ── Leftovers and comments ───────────────────────────────────────────────────

const string_literal = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
const regex_literal = /(^|[(,=:[!&|?{};])(\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[dgimsuvy]*/g;

// A line of code with its strings and regular expressions blanked, so a check reads only the code around them.
export function code_only(line: string): string {
  return line.replace(string_literal, '""').replace(regex_literal, "$1$2/./");
}

const code_file = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|nix|sh)$/;

const leftover_patterns: [RegExp, string][] = [
  [/\bconsole\.(?:log|debug)\(/, "logs to the console"],
  [/\bdebugger\b/, "stops in the debugger"],
  [/\b(?:TODO|FIXME|XXX)\b(?!.*#\d+)/, "leaves a TODO without an issue"],
  [/^\s*\/\/\s*(?:const|let|var|if|for|return|import|function)\b.*[;{)]\s*$/, "leaves code commented out"],
];

// Debug output, commented-out code and TODOs without an issue in the lines a change added.
export function check_leftovers(files: ChangedFile[]): GateResult {
  const findings: string[] = [];
  for (const file of files.filter((each) => code_file.test(each.path) && !each.path.startsWith("tests/fixtures/"))) {
    for (const added of file.added) {
      const code = code_only(added.text);
      for (const [pattern, what] of leftover_patterns) if (pattern.test(code)) findings.push(`${file.path}:${added.line} ${what}`);
    }
  }
  return verdict("leftovers", findings);
}

const line_comment = /^\s*(?:\/\/|#)(?!\s*[─=#-]{2,})(?!!)/;

// Comments of more than one line in what a change added; each comment is one plain line, but for a file's opening overview.
export function check_comments(files: ChangedFile[]): GateResult {
  const findings: string[] = [];
  for (const file of files.filter((each) => code_file.test(each.path))) {
    // The file's opening overview may run long; after a #! line it starts on the second line.
    const first = file.added[0]?.line === 1 ? file.added[0].text : (file.first_line ?? "");
    const overview_line = first.startsWith("#!") ? 2 : 1;
    let run_start: number | null = null;
    let run_length = 0;
    let last_line = -1;
    const close = () => {
      if (run_start !== null && run_start !== overview_line && run_length > 1) findings.push(`${file.path}:${run_start} has a comment ${run_length} lines long`);
      run_start = null;
      run_length = 0;
    };
    for (const added of file.added) {
      const is_comment = line_comment.test(added.text);
      if (is_comment && run_start !== null && added.line === last_line + 1) run_length += 1;
      else {
        close();
        if (is_comment) {
          run_start = added.line;
          run_length = 1;
        }
      }
      last_line = added.line;
    }
    close();
    for (const added of file.added) if (/^\s*\/\*(?!.*\*\/)/.test(added.text) && !file.path.endsWith(".css")) findings.push(`${file.path}:${added.line} opens a block comment`);
  }
  return verdict("comments", findings);
}

// ── Size ─────────────────────────────────────────────────────────────────────

export const most_file_lines = 500;

// Changed files grown past a length a reader can hold in their head; a warning for Review, not a failure.
export function check_size(line_counts: Record<string, number>): GateResult {
  const long = Object.entries(line_counts).filter(([path, count]) => code_file.test(path) && count > most_file_lines);
  return verdict("size", long.map(([path, count]) => `${path} is ${count} lines long, over ${most_file_lines}`), "warning");
}

// ── X-Libs ───────────────────────────────────────────────────────────────────

// Libraries X-Libs wraps, which an app reaches through X-Libs and never imports itself.
export const wrapped_libraries = ["drizzle-orm", "@tanstack/react-table", "lucide-react", "marked", "dompurify", "@tiptap/", "fflate", "rrule", "frimousse", "squarify", "react-error-boundary", "es-module-lexer", "hookable", "parse-duration", "pretty-bytes"];

const import_from = /^\s*(?:import|export)\b[^"'`]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/;

export function check_x_libs(files: ChangedFile[], is_x_libs: boolean): GateResult {
  if (is_x_libs) return passed("x-libs");
  const findings: string[] = [];
  for (const file of files) {
    for (const added of file.added) {
      const match = import_from.exec(added.text);
      const source = match?.[1] ?? match?.[2] ?? match?.[3];
      const wrapped = source && wrapped_libraries.find((library) => (library.endsWith("/") ? source.startsWith(library) : source === library || source.startsWith(`${library}/`)));
      if (wrapped) findings.push(`${file.path}:${added.line} imports ${source}, which X-Libs wraps; import it from X-Libs`);
    }
  }
  return verdict("x-libs", findings);
}

// ── Coverage ─────────────────────────────────────────────────────────────────

const threshold_keys = ["lines", "statements", "functions", "branches"];

// The coverage floor's numbers in a vitest config's text.
export function read_thresholds(config: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const key of threshold_keys) {
    const value = new RegExp(`\\b${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`).exec(config)?.[1];
    if (value !== undefined) found[key] = Number(value);
  }
  return found;
}

// A floor lowered, or code newly excluded from coverage, between the config before and after.
export function check_coverage(before: string | null, after: string | null): GateResult {
  if (after === null) return before === null ? skipped("coverage", "the repository has no vitest.config.ts") : { gate: "coverage", outcome: "failed", findings: ["vitest.config.ts was deleted"] };
  if (before === null) return passed("coverage");
  const old_floor = read_thresholds(before);
  const new_floor = read_thresholds(after);
  const findings = threshold_keys.filter((key) => old_floor[key] !== undefined && (new_floor[key] ?? 0) < old_floor[key]!).map((key) => `the ${key} floor went from ${old_floor[key]} to ${new_floor[key] ?? "nothing"}`);
  const excludes = (text: string) => (/coverage\s*:\s*\{[\s\S]*?\bexclude\s*:\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const new_excludes = excludes(after).filter((entry) => !excludes(before).includes(entry));
  for (const entry of new_excludes) findings.push(`${entry} was newly left out of coverage`);
  return verdict("coverage", findings);
}

// ── Dependencies ─────────────────────────────────────────────────────────────

// Licences that cannot be combined with GPL-3.0-or-later.
const incompatible_licences = /\b(?:proprietary|unlicensed|SSPL|BUSL|BSL-1\.1|CC-BY-NC|Commons Clause|Elastic)\b/i;

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

// New dependencies, named for Review with their licences; one whose licence cannot sit beside GPL-3.0-or-later fails.
export function check_dependencies(before: Manifest | null, after: Manifest | null, licence_of: (name: string) => string | null): GateResult {
  if (!after) return passed("dependencies");
  const old_names = new Set([...Object.keys(before?.dependencies ?? {}), ...Object.keys(before?.devDependencies ?? {})]);
  const added = [...Object.keys(after.dependencies ?? {}), ...Object.keys(after.devDependencies ?? {})].filter((name) => !old_names.has(name));
  if (!added.length) return passed("dependencies");
  const findings = added.map((name) => {
    const licence = licence_of(name);
    return { name, licence, line: `${name} is new, licensed ${licence ?? "as it does not say"}` };
  });
  const bad = findings.filter((finding) => finding.licence !== null && incompatible_licences.test(finding.licence));
  if (bad.length) return { gate: "dependencies", outcome: "failed", findings: bad.map((finding) => `${finding.line}, which cannot sit beside GPL-3.0-or-later`) };
  return { gate: "dependencies", outcome: "warning", findings: findings.map((finding) => finding.line) };
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
