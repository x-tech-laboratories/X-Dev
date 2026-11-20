// Every file in an item's worktree, changed or not, and one file's text to read: what git tracks or would track there,
// never .git or node_modules, and never a path that leads out of the worktree, by "..", an absolute path or a symlink.

// ── Imports ──────────────────────────────────────────────────────────────────

import { lstatSync, openSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";

import type { WorktreeFile, WorktreeFiles } from "../shared/runs/runner.ts";

// ── Limits ───────────────────────────────────────────────────────────────────

// The most files listed, so a huge checkout does not swamp the page.
export const file_list_limit = 20_000;

// The most of one file shown.
export const file_size_limit = 1_000_000;

// How much of a file is looked at to tell text from binary.
const sniff_bytes = 8_000;

const skipped_folders = new Set([".git", "node_modules"]);

function is_skipped(path: string): boolean {
  return path.split("/").some((part) => skipped_folders.has(part));
}

// ── Listing ──────────────────────────────────────────────────────────────────

// The worktree's files, tracked and new alike, ignored ones left out, by path.
export async function list_worktree_files(worktree: string): Promise<WorktreeFiles> {
  const result = await run_program(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: worktree, stdout: "keep", stderr: "keep" });
  if (result.exit_code !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  const paths = [...new Set(result.stdout.split("\0").filter((path) => path && !is_skipped(path)))].sort((first, second) => first.localeCompare(second));
  return { paths: paths.slice(0, file_list_limit), truncated: paths.length > file_list_limit };
}

// ── Reading ──────────────────────────────────────────────────────────────────

// The file's place on disk, refused when the path leads out of the worktree or into what is never shown.
export function confined_path(worktree: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`${path} is not a path inside the worktree`);
  if (is_skipped(path.replaceAll("\\", "/"))) throw new Error(`${path} is in a folder X-Dev does not show`);
  const full = join(worktree, path);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new Error(`${path} does not exist in the worktree`);
  }
  const root = realpathSync(worktree);
  const inside = relative(root, real);
  if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) throw new Error(`${path} leads out of the worktree`);
  return real;
}

// One file's text, or why it is not shown: binary, too large, or not a file.
export function read_worktree_file(worktree: string, path: string): WorktreeFile {
  const real = confined_path(worktree, path);
  const link = lstatSync(join(worktree, path));
  const stats = statSync(real);
  if (!stats.isFile()) throw new Error(`${path} is not a file`);
  const base = { path, size: stats.size, symlink: link.isSymbolicLink() };
  if (stats.size > file_size_limit) return { ...base, text: null, reason: "too_large" };
  const handle = openSync(real, "r");
  try {
    const buffer = Buffer.alloc(stats.size);
    readSync(handle, buffer, 0, stats.size, 0);
    if (buffer.subarray(0, sniff_bytes).includes(0)) return { ...base, text: null, reason: "binary" };
    return { ...base, text: buffer.toString("utf8"), reason: "" };
  } finally {
    closeSync(handle);
  }
}
