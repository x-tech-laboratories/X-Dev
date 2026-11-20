// A file's diff laid out for reading: side by side, old on the left and new on the right, or as one column; removed
// and added lines paired so the words that changed within them are marked, through jsdiff; and long unchanged
// stretches folded down to a few lines on each side of a change.

// ── Imports ──────────────────────────────────────────────────────────────────

import { diffWordsWithSpace } from "diff";

import type { DiffFile, DiffLine } from "./parse.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// A piece of a line, marked when it is what changed.
export interface WordPart {
  text: string;
  changed: boolean;
}

export interface Cell {
  number: number;
  parts: WordPart[];
}

// One row of the side-by-side view: an unchanged line on both sides, or a change with either side possibly empty.
export type SplitRow = { kind: "same"; left: Cell; right: Cell } | { kind: "change"; left: Cell | null; right: Cell | null } | { kind: "hunk"; header: string };

// One row of the single-column view.
export type UnifiedRow = { kind: "same" | "removed" | "added"; old_number: number | null; new_number: number | null; parts: WordPart[] } | { kind: "hunk"; header: string };

// A stretch of unchanged rows shown as one "show more" row until opened.
export interface Fold {
  kind: "fold";
  // Where the stretch starts in the rows, which names it.
  start: number;
  count: number;
}

// Lines kept on each side of a change when the rest of an unchanged stretch folds.
export const context_lines = 3;

// ── Words ────────────────────────────────────────────────────────────────────

const whole = (text: string): WordPart[] => [{ text, changed: false }];

// The words of an old and a new line, each side marking what it lost or gained; a line changed through is left whole.
export function word_parts(old_text: string, new_text: string): { old: WordPart[]; new: WordPart[] } {
  const parts = diffWordsWithSpace(old_text, new_text);
  const kept = parts.filter((part) => !part.added && !part.removed).reduce((total, part) => total + part.value.trim().length, 0);
  if (kept === 0) return { old: whole(old_text), new: whole(new_text) };
  return {
    old: parts.filter((part) => !part.added).map((part) => ({ text: part.value, changed: Boolean(part.removed) })),
    new: parts.filter((part) => !part.removed).map((part) => ({ text: part.value, changed: Boolean(part.added) })),
  };
}

// ── Pairing ──────────────────────────────────────────────────────────────────

interface Block {
  removed: DiffLine[];
  added: DiffLine[];
}

// Each hunk's lines walked as unchanged lines and blocks of removed lines followed by added ones.
function walk(file: DiffFile, on_header: (header: string) => void, on_same: (line: DiffLine) => void, on_block: (block: Block) => void): void {
  for (const hunk of file.hunks) {
    if (file.hunks.length > 1) on_header(hunk.header);
    let block: Block = { removed: [], added: [] };
    const flush = () => {
      if (block.removed.length || block.added.length) on_block(block);
      block = { removed: [], added: [] };
    };
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        flush();
        on_same(line);
      } else if (line.kind === "removed") {
        if (block.added.length) flush();
        block.removed.push(line);
      } else block.added.push(line);
    }
    flush();
  }
}

// The paired lines' words, a removed line matched with the added line at the same place in its block.
function paired(block: Block): { old: WordPart[][]; new: WordPart[][] } {
  const old = block.removed.map((line) => whole(line.text));
  const fresh = block.added.map((line) => whole(line.text));
  for (let index = 0; index < Math.min(old.length, fresh.length); index += 1) {
    const words = word_parts(block.removed[index]!.text, block.added[index]!.text);
    old[index] = words.old;
    fresh[index] = words.new;
  }
  return { old, new: fresh };
}

export function split_rows(file: DiffFile): SplitRow[] {
  const rows: SplitRow[] = [];
  walk(
    file,
    (header) => rows.push({ kind: "hunk", header }),
    (line) => rows.push({ kind: "same", left: { number: line.old_number!, parts: whole(line.text) }, right: { number: line.new_number!, parts: whole(line.text) } }),
    (block) => {
      const words = paired(block);
      for (let index = 0; index < Math.max(block.removed.length, block.added.length); index += 1) {
        const old_line = block.removed[index];
        const new_line = block.added[index];
        rows.push({ kind: "change", left: old_line ? { number: old_line.old_number!, parts: words.old[index]! } : null, right: new_line ? { number: new_line.new_number!, parts: words.new[index]! } : null });
      }
    },
  );
  return rows;
}

export function unified_rows(file: DiffFile): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  walk(
    file,
    (header) => rows.push({ kind: "hunk", header }),
    (line) => rows.push({ kind: "same", old_number: line.old_number, new_number: line.new_number, parts: whole(line.text) }),
    (block) => {
      const words = paired(block);
      block.removed.forEach((line, index) => rows.push({ kind: "removed", old_number: line.old_number, new_number: null, parts: words.old[index]! }));
      block.added.forEach((line, index) => rows.push({ kind: "added", old_number: null, new_number: line.new_number, parts: words.new[index]! }));
    },
  );
  return rows;
}

// ── Folding ──────────────────────────────────────────────────────────────────

// The rows with each long unchanged stretch cut to a few lines beside its changes, the rest a fold, unless opened.
export function fold_rows<Row extends { kind: string }>(rows: Row[], opened: ReadonlySet<number>, context = context_lines): (Row | Fold)[] {
  const shown: (Row | Fold)[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index]!.kind !== "same") {
      shown.push(rows[index]!);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end]!.kind === "same") end += 1;
    const keep_before = index === 0 ? 0 : context;
    const keep_after = end === rows.length ? 0 : context;
    const hidden = end - index - keep_before - keep_after;
    if (hidden > 1 && !opened.has(index)) {
      shown.push(...rows.slice(index, index + keep_before), { kind: "fold", start: index, count: hidden }, ...rows.slice(end - keep_after, end));
    } else {
      shown.push(...rows.slice(index, end));
    }
    index = end;
  }
  return shown;
}
