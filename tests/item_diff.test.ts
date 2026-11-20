import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { read_item_diff, read_run_changes, sum_numstat, within_limit } from "../src/server/item_diff.ts";
import { diff_totals, parse_unified_diff } from "../src/shared/diff/parse.ts";
import { insert_run, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

const repository = "x-tech-laboratories/X-Dev";

// ============================================================================
// Reading a diff
// ============================================================================

const sample = [
  "diff --git a/src/board.ts b/src/board.ts",
  "index 1111111..2222222 100644",
  "--- a/src/board.ts",
  "+++ b/src/board.ts",
  "@@ -1,3 +1,3 @@ export function board()",
  " keep",
  "-old line",
  "+new line",
  " tail",
  "\\ No newline at end of file",
  "diff --git a/notes.md b/notes.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/old.ts b/new.ts",
  "similarity index 100%",
  "rename from old.ts",
  "rename to new.ts",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "",
].join("\n");

describe("a unified diff", () => {
  it("reads into files with their status, counts and numbered lines", () => {
    const files = parse_unified_diff(sample);

    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["src/board.ts", "changed", 1, 1],
      ["notes.md", "added", 1, 0],
      ["new.ts", "renamed", 0, 0],
      ["gone.txt", "removed", 0, 1],
    ]);
    expect(files[0]!.hunks[0]).toEqual({
      header: "@@ -1,3 +1,3 @@ export function board()",
      lines: [
        { kind: "context", text: "keep", old_number: 1, new_number: 1 },
        { kind: "removed", text: "old line", old_number: 2, new_number: null },
        { kind: "added", text: "new line", old_number: null, new_number: 2 },
        { kind: "context", text: "tail", old_number: 3, new_number: 3 },
      ],
    });
    expect(files[2]).toMatchObject({ old_path: "old.ts", hunks: [] });
    expect(diff_totals(files)).toEqual({ additions: 2, deletions: 2 });
  });

  it("is cut at the last whole file once it runs past the limit", () => {
    const two = "diff --git a/a b/a\n+x\ndiff --git a/b b/b\n+y\n";
    expect(within_limit(two, 1000)).toEqual({ text: two, truncated: false });
    expect(within_limit(two, 25)).toEqual({ text: "diff --git a/a b/a\n+x\n", truncated: true });
    expect(within_limit(two, 5)).toEqual({ text: "", truncated: true });
  });

  it("counts numstat's added and removed lines, leaving binary files out", () => {
    expect(sum_numstat("3\t1\ta.ts\n-\t-\timage.png\n10\t0\tb.ts\n")).toEqual({ additions: 13, deletions: 1 });
  });
});

// ============================================================================
// An item's worktree
// ============================================================================

function git(folder: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.org", ...args], { cwd: folder, encoding: "utf8" }).trim();
}

function setup() {
  const checkout = mkdtempSync(join(tmpdir(), "x-dev-diff-"));
  git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "# Test\nline\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "chore: start");
  const worktree = join(checkout, ".claude", "worktrees", "item-7");
  mkdirSync(join(checkout, ".claude", "worktrees"), { recursive: true });
  git(checkout, "worktree", "add", "-q", "-b", "worktree-item-7", worktree);
  const start = git(worktree, "rev-parse", "HEAD");

  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const item_id = store.save_item({ title: "Diff view", repository, issue_number: 7 });
  database.prepare("UPDATE items SET branch = 'worktree-item-7' WHERE id = ?").run(item_id);
  return { checkout, worktree, start, database, store, item_id };
}

describe("an item's diff", () => {
  it("shows the branch's commits and uncommitted changes against the commit its first run started from", async () => {
    const { checkout, worktree, start, database, store, item_id } = setup();
    const run_id = insert_run(database, { item_id, stage: "implement", model: "", effort: "", session_id: "s", start_commit: start, status_before: "{}", input: "", started_at: "2026-11-20T10:00:00.000Z" });
    writeFileSync(join(worktree, "board.ts"), "export const lanes = 1;\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "feat: board");
    const end = git(worktree, "rev-parse", "HEAD");
    update_run(database, run_id, { state: "done", end_commit: end });
    writeFileSync(join(worktree, "README.md"), "# Test\nchanged\n");

    const diff = await read_item_diff(database, store.get_item(item_id), { [repository]: checkout });

    expect(diff).toMatchObject({ base: start, truncated: false, problem: "" });
    expect(diff.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ["README.md", 1, 1],
      ["board.ts", 1, 0],
    ]);
    expect(await read_run_changes(database, [run_id, "missing"], { [repository]: checkout })).toEqual({ [run_id]: { additions: 1, deletions: 0 } });
    rmSync(checkout, { recursive: true, force: true });
  });

  it("counts from where the branch left the default branch before any run", async () => {
    const { checkout, worktree, start, database, store, item_id } = setup();
    writeFileSync(join(worktree, "new.txt"), "new\n");
    git(worktree, "add", ".");

    const diff = await read_item_diff(database, store.get_item(item_id), { [repository]: checkout });

    expect(diff.base).toBe(start);
    expect(diff.files.map((file) => file.path)).toEqual(["new.txt"]);
    rmSync(checkout, { recursive: true, force: true });
  });

  it("says why there is nothing to show without a checkout or a worktree", async () => {
    const { checkout, database, store, item_id } = setup();
    const item = store.get_item(item_id);

    expect((await read_item_diff(database, item, {})).problem).toContain("does not know where");
    expect((await read_item_diff(database, { ...item, branch: "" }, { [repository]: checkout })).problem).toContain("no worktree yet");
    expect(await read_run_changes(database, [], {})).toEqual({});
    rmSync(checkout, { recursive: true, force: true });
  });
});
