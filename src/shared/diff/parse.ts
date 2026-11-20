// A unified diff, as git diff prints it, read into files, hunks and lines with their numbers, through parse-diff.

// ── Imports ──────────────────────────────────────────────────────────────────

import parse_diff from "parse-diff";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type DiffLineKind = "added" | "removed" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  // The line's number before and after the change; null on the side it is missing from.
  old_number: number | null;
  new_number: number | null;
}

export interface DiffHunk {
  // The @@ line, with the function or heading git found around it.
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "removed" | "renamed" | "changed";

export interface DiffFile {
  path: string;
  // The path before a rename; the same as path otherwise.
  old_path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  // Empty for a binary file, a bare rename or a change of mode, which have no lines to show.
  hunks: DiffHunk[];
}

// ── Reading ──────────────────────────────────────────────────────────────────

const no_file = "/dev/null";

function status_of(file: parse_diff.File, path: string, old_path: string): DiffFileStatus {
  if (file.new || file.from === no_file) return "added";
  if (file.deleted || file.to === no_file) return "removed";
  return path === old_path ? "changed" : "renamed";
}

function line_of(change: parse_diff.Change): DiffLine {
  // parse-diff keeps the leading +, - or space, which the view draws apart.
  const text = change.content.slice(1);
  if (change.type === "add") return { kind: "added", text, old_number: null, new_number: change.ln };
  if (change.type === "del") return { kind: "removed", text, old_number: change.ln, new_number: null };
  return { kind: "context", text, old_number: change.ln1, new_number: change.ln2 };
}

// The files a unified diff changes, in the order it lists them.
export function parse_unified_diff(text: string): DiffFile[] {
  return parse_diff(text).map((file) => {
    const path = file.to && file.to !== no_file ? file.to : (file.from ?? "");
    const old_path = file.from && file.from !== no_file ? file.from : path;
    const hunks = file.chunks.map((chunk) => ({ header: chunk.content, lines: chunk.changes.filter((change) => !change.content.startsWith("\\")).map(line_of) }));
    return { path, old_path, status: status_of(file, path, old_path), additions: file.additions, deletions: file.deletions, hunks };
  });
}

// The whole change's added and removed line counts.
export function diff_totals(files: DiffFile[]): { additions: number; deletions: number } {
  return files.reduce((total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }), { additions: 0, deletions: 0 });
}
