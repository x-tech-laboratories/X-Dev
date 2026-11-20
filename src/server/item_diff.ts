// What an item's branch changed, read with git in the item's worktree: the files changed since a run or the item's
// work started, uncommitted and new files included, each with a fingerprint of its content now; one file's whole diff
// for the side-by-side view; putting one file back as it was; and the lines and reviewed files of each finished run.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { parse_unified_diff, type DiffFileStatus } from "../shared/diff/parse.ts";
import type { Item } from "../shared/items/model.ts";
import type { ChangedFile, ChangeScope, ChangeSet, FileChange, LineCounts } from "../shared/runs/runner.ts";

// ── Git ──────────────────────────────────────────────────────────────────────

// The most of a diff read; a longer one is cut at the last whole file before it.
export const diff_limit_in_characters = 4_000_000;

// Enough lines of context to show a file whole, so the view folds unchanged stretches itself.
const whole_file_context = 1_000_000;

// The fingerprint of a file the change removed.
export const deleted_fingerprint = "deleted";

async function git(args: string[], cwd: string, allowed_exit_codes = [0]): Promise<string> {
  const result = await run_program(["git", ...args], { cwd, stdout: "keep", stderr: "keep" });
  if (!allowed_exit_codes.includes(result.exit_code)) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  return result.stdout;
}

// The diff cut at the last whole file within the limit, and whether it was cut.
export function within_limit(text: string, limit = diff_limit_in_characters): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.lastIndexOf("\ndiff --git ", limit);
  return { text: cut > 0 ? text.slice(0, cut + 1) : "", truncated: true };
}

// The worktree an item's runs work in on this computer, or empty when it has none.
function worktree_of(item: Pick<Item, "repository" | "branch">, repositories: Record<string, string>): string {
  const folder = repositories[item.repository];
  if (!folder || !item.branch) return "";
  const worktree = join(folder, ".claude", "worktrees", item.branch.replace(/^worktree-/, ""));
  return existsSync(worktree) ? worktree : "";
}

// The lines git's numstat output counts as added and removed, binary files left out.
export function sum_numstat(text: string): Pick<LineCounts, "additions" | "deletions"> {
  let additions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    const [added, removed] = line.split("\t");
    if (!added || added === "-") continue;
    additions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  return { additions, deletions };
}

// ── Reading git's lists ──────────────────────────────────────────────────────

const status_letters: Record<string, DiffFileStatus> = { A: "added", D: "removed", R: "renamed", C: "added", M: "changed", T: "changed" };

interface RawChange {
  path: string;
  old_path: string;
  status: DiffFileStatus;
  // The blob of the new side, all zeros when it is the worktree's own file.
  blob: string;
}

const no_blob = /^0+$/;

// `git diff --raw -z` output read into changes; a rename names its old path first.
export function read_raw(text: string): RawChange[] {
  const parts = text.split("\0");
  const changes: RawChange[] = [];
  for (let index = 0; index < parts.length - 1; ) {
    const fields = parts[index]!.replace(/^:/, "").split(" ");
    const letter = fields[4]?.[0] ?? "M";
    const blob = fields[3] ?? "";
    if (letter === "R" || letter === "C") {
      changes.push({ old_path: parts[index + 1]!, path: parts[index + 2]!, status: status_letters[letter]!, blob });
      index += 3;
    } else {
      changes.push({ old_path: parts[index + 1]!, path: parts[index + 1]!, status: status_letters[letter] ?? "changed", blob });
      index += 2;
    }
  }
  return changes;
}

// `git diff --numstat -z` output as each path's added and removed lines, null for a binary file.
export function read_numstat(text: string): Map<string, { additions: number; deletions: number } | null> {
  const parts = text.split("\0");
  const counts = new Map<string, { additions: number; deletions: number } | null>();
  for (let index = 0; index < parts.length - 1; ) {
    const [added, removed, path] = parts[index]!.split("\t");
    const binary = added === "-";
    const value = binary ? null : { additions: Number(added) || 0, deletions: Number(removed) || 0 };
    // A rename leaves the path empty and names the old and new paths after it.
    if (path === "") {
      counts.set(parts[index + 2]!, value);
      index += 3;
    } else {
      counts.set(path!, value);
      index += 1;
    }
  }
  return counts;
}

// ── Changes ──────────────────────────────────────────────────────────────────

interface ChangeContext {
  database: SqlDatabase;
  item: Item;
  repositories: Record<string, string>;
}

// The commit the item's work started from: its first run's, else where its branch left the default branch.
async function item_base(database: SqlDatabase, item_id: string, worktree: string): Promise<string> {
  const first = database.prepare("SELECT start_commit FROM runs WHERE item_id = ? AND start_commit != '' ORDER BY started_at LIMIT 1").get(item_id) as { start_commit: string } | undefined;
  if (first) return first.start_commit;
  const default_branch = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], worktree).catch(() => "HEAD")).trim();
  return (await git(["merge-base", "HEAD", default_branch], worktree)).trim();
}

// The run a run scope reads: the one named, else the item's latest that was not discarded.
function scope_run(database: SqlDatabase, item_id: string, run_id: string): { id: string; start_commit: string } | undefined {
  if (run_id) return database.prepare("SELECT id, start_commit FROM runs WHERE id = ? AND item_id = ?").get(run_id, item_id) as { id: string; start_commit: string } | undefined;
  return database.prepare("SELECT id, start_commit FROM runs WHERE item_id = ? AND state != 'discarded' ORDER BY started_at DESC LIMIT 1").get(item_id) as { id: string; start_commit: string } | undefined;
}

type Where = { worktree: string; base: string; run_id: string } | { problem: string; run_id: string };

// Where a scope's changes are read: the worktree and the commit they count from, or why there is nothing to read.
async function where_of({ database, item, repositories }: ChangeContext, scope: ChangeScope, run_id: string): Promise<Where> {
  if (!repositories[item.repository]) return { problem: `X-Dev does not know where ${item.repository} is on this computer.`, run_id: "" };
  const worktree = worktree_of(item, repositories);
  if (!worktree) return { problem: "The item has no worktree yet; its first run makes one.", run_id: "" };
  const run = scope_run(database, item.id, run_id);
  if (scope === "item") return { worktree, base: await item_base(database, item.id, worktree), run_id: run?.id ?? "" };
  if (!run?.start_commit) return { problem: "The run has no commit it started from, so its own changes cannot be told apart.", run_id: run?.id ?? "" };
  return { worktree, base: run.start_commit, run_id: run.id };
}

// The changed files' content fingerprints: the blob of what each holds now, or "deleted".
async function fingerprints(worktree: string, changes: RawChange[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unknown: string[] = [];
  for (const change of changes) {
    if (change.status === "removed") found.set(change.path, deleted_fingerprint);
    else if (no_blob.test(change.blob)) unknown.push(change.path);
    else found.set(change.path, change.blob);
  }
  if (unknown.length) {
    const hashes = (await git(["hash-object", "--", ...unknown], worktree)).trim().split("\n");
    unknown.forEach((path, index) => found.set(path, hashes[index] ?? ""));
  }
  return found;
}

// Files git does not track yet, which a diff against a commit leaves out.
async function untracked(worktree: string): Promise<RawChange[]> {
  const text = await git(["ls-files", "--others", "--exclude-standard", "-z"], worktree);
  return text
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, old_path: path, status: "added" as const, blob: "0" }));
}

function counted_lines(worktree: string, path: string): { additions: number; deletions: number } | null {
  try {
    const content = readFileSync(join(worktree, path));
    if (content.includes(0)) return null;
    const text = content.toString("utf8");
    return { additions: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, deletions: 0 };
  } catch {
    return null;
  }
}

// The files changed in the scope, by path, each with its status, counts and the fingerprint of its content now.
export async function read_changes(context: ChangeContext, scope: ChangeScope, run_id: string): Promise<ChangeSet> {
  const where = await where_of(context, scope, run_id);
  if ("problem" in where) return { base: "", run_id: where.run_id, files: [], problem: where.problem };
  const { worktree, base } = where;
  const [raw, numstat, fresh] = await Promise.all([git(["diff", "--raw", "--no-abbrev", "-z", "--find-renames", base], worktree), git(["diff", "--numstat", "-z", "--find-renames", base], worktree), untracked(worktree)]);
  const changes = [...read_raw(raw), ...fresh];
  const counts = read_numstat(numstat);
  const prints = await fingerprints(worktree, changes);
  const files: ChangedFile[] = changes.map((change) => {
    const count = counts.has(change.path) ? counts.get(change.path)! : counted_lines(worktree, change.path);
    return { path: change.path, old_path: change.old_path, status: change.status, additions: count?.additions ?? 0, deletions: count?.deletions ?? 0, binary: count === null, fingerprint: prints.get(change.path) ?? "" };
  });
  files.sort((first, second) => first.path.localeCompare(second.path));
  return { base, run_id: where.run_id, files, problem: "" };
}

// One file's change shown whole, every unchanged line kept for the view to fold.
export async function read_file_change(context: ChangeContext, scope: ChangeScope, run_id: string, path: string): Promise<FileChange> {
  const where = await where_of(context, scope, run_id);
  if ("problem" in where) throw new Error(where.problem);
  const set = await read_changes(context, scope, run_id);
  const changed = set.files.find((file) => file.path === path);
  if (!changed) throw new Error(`${path} has not changed since then`);
  const is_untracked = (await git(["ls-files", "--others", "--exclude-standard", "--", path], where.worktree)).trim() !== "";
  const text = is_untracked
    ? await git(["diff", "--no-color", "--no-ext-diff", "--no-index", `-U${whole_file_context}`, "--", "/dev/null", path], where.worktree, [0, 1])
    : await git(["diff", "--no-color", "--no-ext-diff", `-U${whole_file_context}`, "--find-renames", where.base, "--", ...new Set([changed.old_path, path])], where.worktree);
  const kept = within_limit(text);
  const file = parse_unified_diff(kept.text).find((each) => each.path === path) ?? null;
  return { file: file && { ...file, status: changed.status, old_path: changed.old_path }, truncated: kept.truncated };
}

// Puts one file back as it was when the scope started: restored from that commit, or removed when the change added it.
export async function revert_file(context: ChangeContext, scope: ChangeScope, run_id: string, path: string): Promise<{ base: string; run_id: string }> {
  const where = await where_of(context, scope, run_id);
  if ("problem" in where) throw new Error(where.problem);
  const changed = (await read_changes(context, scope, run_id)).files.find((file) => file.path === path);
  if (!changed) throw new Error(`${path} has not changed since then`);
  if (changed.status === "added" || changed.status === "renamed") {
    await git(["rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", path], where.worktree);
    rmSync(join(where.worktree, path), { force: true });
  }
  if (changed.status !== "added") await git(["checkout", where.base, "--", changed.old_path], where.worktree);
  return { base: where.base, run_id: where.run_id };
}

// ── Runs ─────────────────────────────────────────────────────────────────────

// The lines each finished run changed between the commit it started on and the one it ended on, and how many of its
// files the user marked reviewed with the content they hold at its end.
export async function read_run_changes(database: SqlDatabase, run_ids: string[], repositories: Record<string, string>): Promise<Record<string, LineCounts>> {
  const read = database.prepare("SELECT runs.start_commit, runs.end_commit, runs.reviewed, items.repository, items.branch FROM runs JOIN items ON items.id = runs.item_id WHERE runs.id = ?");
  const counted: Record<string, LineCounts> = {};
  for (const run_id of run_ids) {
    const row = read.get(run_id) as { start_commit: string; end_commit: string; reviewed: string; repository: string; branch: string } | undefined;
    if (!row?.start_commit || !row.end_commit) continue;
    const worktree = worktree_of(row, repositories);
    if (!worktree) continue;
    const [numstat, raw] = await Promise.all([
      git(["diff", "--numstat", "--no-renames", row.start_commit, row.end_commit], worktree).catch(() => null),
      git(["diff", "--raw", "--no-abbrev", "-z", "--no-renames", row.start_commit, row.end_commit], worktree).catch(() => ""),
    ]);
    if (numstat === null) continue;
    const reviewed = JSON.parse(row.reviewed) as Record<string, string>;
    const files = read_raw(raw);
    const marked = files.filter((file) => reviewed[file.path] === (file.status === "removed" ? deleted_fingerprint : file.blob)).length;
    counted[run_id] = { ...sum_numstat(numstat), files: files.length, reviewed: marked };
  }
  return counted;
}
