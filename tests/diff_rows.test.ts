import { describe, expect, it } from "vitest";

import { parse_unified_diff } from "../src/shared/diff/parse.ts";
import { fold_rows, split_rows, unified_rows, word_parts } from "../src/shared/diff/rows.ts";

const lines = (count: number, from = 1) => Array.from({ length: count }, (_, index) => ` same ${from + index}`);

// A file of twenty lines with one line changed in the middle and one added at the end, shown whole.
const file = parse_unified_diff(
  ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,20 +1,21 @@", ...lines(9), "-const lanes = 1;", "+const lanes = 2;", ...lines(10, 11), "+tail();", ""].join("\n"),
)[0]!;

describe("a file's diff laid out", () => {
  it("side by side, a changed line paired with its new one and the changed word marked", () => {
    const rows = split_rows(file);
    expect(rows).toHaveLength(21);
    expect(rows[9]).toEqual({
      kind: "change",
      left: { number: 10, parts: [{ text: "const lanes = ", changed: false }, { text: "1", changed: true }, { text: ";", changed: false }] },
      right: { number: 10, parts: [{ text: "const lanes = ", changed: false }, { text: "2", changed: true }, { text: ";", changed: false }] },
    });
    expect(rows[20]).toEqual({ kind: "change", left: null, right: { number: 21, parts: [{ text: "tail();", changed: false }] } });
  });

  it("in one column, removed lines before added ones", () => {
    const rows = unified_rows(file);
    expect(rows.slice(9, 11).map((row) => row.kind !== "hunk" && [row.kind, row.old_number, row.new_number])).toEqual([
      ["removed", 10, null],
      ["added", null, 10],
    ]);
  });

  it("folds long unchanged stretches down to three lines beside each change, unless opened", () => {
    const folded = fold_rows(split_rows(file), new Set());
    expect(folded.map((row) => row.kind)).toEqual(["fold", "same", "same", "same", "change", "same", "same", "same", "fold", "same", "same", "same", "change"]);
    expect(folded[0]).toEqual({ kind: "fold", start: 0, count: 6 });
    expect(folded[8]).toEqual({ kind: "fold", start: 10, count: 4 });
    expect(fold_rows(split_rows(file), new Set([0, 10]))).toHaveLength(21);
  });

  it("marks hunks apart when a file has several", () => {
    const two = parse_unified_diff(["diff --git a/b b/b", "--- a/b", "+++ b/b", "@@ -1 +1 @@", "-x", "+y", "@@ -9 +9 @@ end", "-p", "+q", ""].join("\n"))[0]!;
    expect(split_rows(two).map((row) => row.kind)).toEqual(["hunk", "change", "hunk", "change"]);
    expect(unified_rows(two)[0]).toEqual({ kind: "hunk", header: "@@ -1 +1 @@" });
  });
});

describe("the words of a changed line", () => {
  it("are left whole when nothing but spaces stayed the same", () => {
    expect(word_parts("alpha beta", "gamma delta")).toEqual({ old: [{ text: "alpha beta", changed: false }], new: [{ text: "gamma delta", changed: false }] });
  });
});
