// What an item's branch changed: git's diff in the item's worktree against the commit its work started from, read
// into files and lines for the item page, changing nothing.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { join } from "node:path";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { parse_unified_diff } from "../shared/diff/parse.ts";
import type { Item } from "../shared/items/model.ts";
import type { ItemDiff, LineCounts } from "../shared/runs/runner.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

// The most of a diff read; a longer one is cut at the last whole file before it.
export const diff_limit_in_characters = 4_000_000;

async function git(args: string[], cwd: string): Promise<string> {
  const result = await run_program(["git", ...args], { cwd, stdout: "keep", stderr: "keep" });
  if (result.exit_code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  return result.stdout;
}

// The commit the item's work started from: its first run's, else where its branch left the default branch.
async function base_of(database: SqlDatabase, item_id: string, worktree: string): Promise<string> {
  const first = database.prepare("SELECT start_commit FROM runs WHERE item_id = ? AND start_commit != '' ORDER BY started_at LIMIT 1").get(item_id) as { start_commit: string } | undefined;
  if (first) return first.start_commit;
  const default_branch = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], worktree).catch(() => "HEAD")).trim();
  return (await git(["merge-base", "HEAD", default_branch], worktree)).trim();
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
export function sum_numstat(text: string): LineCounts {
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

// The lines each finished run changed between the commit it started on and the one it ended on.
export async function read_run_changes(database: SqlDatabase, run_ids: string[], repositories: Record<string, string>): Promise<Record<string, LineCounts>> {
  const read = database.prepare("SELECT runs.start_commit, runs.end_commit, items.repository, items.branch FROM runs JOIN items ON items.id = runs.item_id WHERE runs.id = ?");
  const counted: Record<string, LineCounts> = {};
  for (const run_id of run_ids) {
    const row = read.get(run_id) as { start_commit: string; end_commit: string; repository: string; branch: string } | undefined;
    if (!row?.start_commit || !row.end_commit) continue;
    const worktree = worktree_of(row, repositories);
    if (!worktree) continue;
    const text = await git(["diff", "--numstat", "--no-renames", row.start_commit, row.end_commit], worktree).catch(() => null);
    if (text !== null) counted[run_id] = sum_numstat(text);
  }
  return counted;
}

// The item's changes since its work started, uncommitted ones included; a problem in plain words when there is nothing to read.
export async function read_item_diff(database: SqlDatabase, item: Item, repositories: Record<string, string>): Promise<ItemDiff> {
  const empty = { base: "", files: [], truncated: false };
  if (!repositories[item.repository]) return { ...empty, problem: `X-Dev does not know where ${item.repository} is on this computer.` };
  const worktree = worktree_of(item, repositories);
  if (!worktree) return { ...empty, problem: "The item has no worktree yet; its first run makes one." };
  const base = await base_of(database, item.id, worktree);
  const text = await git(["diff", "--no-color", "--no-ext-diff", "--find-renames", base], worktree);
  const kept = within_limit(text);
  return { base, files: parse_unified_diff(kept.text), truncated: kept.truncated, problem: "" };
}
