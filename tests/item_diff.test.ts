import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { read_changes, read_file_change, read_numstat, read_raw, read_run_changes, revert_file, sum_numstat, within_limit } from "../src/server/item_diff.ts";
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

describe("git's lists", () => {
  it("read raw changes, a rename naming its old path first", () => {
    const raw = [":100644 100644 aaa bbb M", "src/a.ts", ":100644 100644 ccc ddd R100", "old.ts", "new.ts", ":000000 100644 000 eee A", "b.ts", ""].join("\0");
    expect(read_raw(raw)).toEqual([
      { path: "src/a.ts", old_path: "src/a.ts", status: "changed", blob: "bbb" },
      { path: "new.ts", old_path: "old.ts", status: "renamed", blob: "ddd" },
      { path: "b.ts", old_path: "b.ts", status: "added", blob: "eee" },
    ]);
  });

  it("read numstat counts, a binary file as null and a rename by its new path", () => {
    const counts = read_numstat(["3\t1\tsrc/a.ts", "-\t-\tlogo.png", "0\t0\t", "old.ts", "new.ts", ""].join("\0"));
    expect([...counts]).toEqual([
      ["src/a.ts", { additions: 3, deletions: 1 }],
      ["logo.png", null],
      ["new.ts", { additions: 0, deletions: 0 }],
    ]);
  });
});

describe("an item's changes", () => {
  it("lists the files changed since the item's work started, committed, uncommitted and new, each with a fingerprint", async () => {
    const { checkout, worktree, start, database, store, item_id } = setup();
    const run_id = insert_run(database, { item_id, stage: "implement", model: "", effort: "", session_id: "s", start_commit: start, status_before: "{}", input: "", started_at: "2026-11-20T10:00:00.000Z" });
    writeFileSync(join(worktree, "board.ts"), "export const lanes = 1;\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "feat: board");
    const end = git(worktree, "rev-parse", "HEAD");
    update_run(database, run_id, { state: "done", end_commit: end, reviewed: { "board.ts": git(worktree, "rev-parse", "HEAD:board.ts") } });
    writeFileSync(join(worktree, "README.md"), "# Test\nchanged\n");
    mkdirSync(join(worktree, "docs"));
    writeFileSync(join(worktree, "docs", "new.md"), "one\ntwo\n");
    const context = { database, item: store.get_item(item_id), repositories: { [repository]: checkout } };

    const changes = await read_changes(context, "item", "");

    expect(changes).toMatchObject({ base: start, run_id, problem: "" });
    expect(changes.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["board.ts", "added", 1, 0],
      ["docs/new.md", "added", 2, 0],
      ["README.md", "changed", 1, 1],
    ]);
    expect(changes.files[0]!.fingerprint).toBe(git(worktree, "rev-parse", "HEAD:board.ts"));
    expect(changes.files[2]!.fingerprint).toBe(git(worktree, "hash-object", "README.md"));
    expect(await read_run_changes(database, [run_id, "missing"], { [repository]: checkout })).toEqual({ [run_id]: { additions: 1, deletions: 0, files: 1, reviewed: 1 } });
    rmSync(checkout, { recursive: true, force: true });
  });

  it("counts a run's changes from the commit it started on", async () => {
    const { checkout, worktree, database, store, item_id } = setup();
    writeFileSync(join(worktree, "first.txt"), "first\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "feat: first");
    const middle = git(worktree, "rev-parse", "HEAD");
    insert_run(database, { item_id, stage: "plan", model: "", effort: "", session_id: "s", start_commit: git(worktree, "rev-parse", "HEAD~1"), status_before: "{}", input: "", started_at: "2026-11-20T09:00:00.000Z" });
    const second = insert_run(database, { item_id, stage: "implement", model: "", effort: "", session_id: "s", start_commit: middle, status_before: "{}", input: "", started_at: "2026-11-20T10:00:00.000Z" });
    writeFileSync(join(worktree, "second.txt"), "second\n");
    const context = { database, item: store.get_item(item_id), repositories: { [repository]: checkout } };

    expect((await read_changes(context, "run", "")).files.map((file) => file.path)).toEqual(["second.txt"]);
    expect((await read_changes(context, "run", second)).run_id).toBe(second);
    expect((await read_changes(context, "item", "")).files.map((file) => file.path)).toEqual(["first.txt", "second.txt"]);
    rmSync(checkout, { recursive: true, force: true });
  });

  it("shows one file whole, a new file too, and puts files back as they were", async () => {
    const { checkout, worktree, start, database, store, item_id } = setup();
    insert_run(database, { item_id, stage: "implement", model: "", effort: "", session_id: "s", start_commit: start, status_before: "{}", input: "", started_at: "2026-11-20T10:00:00.000Z" });
    writeFileSync(join(worktree, "README.md"), "# Test\nline\nmore\n");
    writeFileSync(join(worktree, "fresh.txt"), "fresh\n");
    const context = { database, item: store.get_item(item_id), repositories: { [repository]: checkout } };

    const readme = await read_file_change(context, "run", "", "README.md");
    expect(readme.file!.hunks[0]!.lines.map((line) => [line.kind, line.text])).toEqual([
      ["context", "# Test"],
      ["context", "line"],
      ["added", "more"],
    ]);
    expect((await read_file_change(context, "run", "", "fresh.txt")).file).toMatchObject({ path: "fresh.txt", status: "added", additions: 1 });
    await expect(read_file_change(context, "run", "", "nothing.txt")).rejects.toThrow("has not changed since then");

    expect(await revert_file(context, "run", "", "README.md")).toMatchObject({ base: start });
    await revert_file(context, "run", "", "fresh.txt");
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("# Test\nline\n");
    expect(existsSync(join(worktree, "fresh.txt"))).toBe(false);
    expect((await read_changes(context, "run", "")).files).toEqual([]);
    rmSync(checkout, { recursive: true, force: true });
  });

  it("puts back a renamed file under its old name and a deleted one whole", async () => {
    const { checkout, worktree, start, database, store, item_id } = setup();
    insert_run(database, { item_id, stage: "implement", model: "", effort: "", session_id: "s", start_commit: start, status_before: "{}", input: "", started_at: "2026-11-20T10:00:00.000Z" });
    git(worktree, "mv", "README.md", "MOVED.md");
    git(worktree, "commit", "-q", "-m", "refactor: move");
    const context = { database, item: store.get_item(item_id), repositories: { [repository]: checkout } };
    expect((await read_changes(context, "run", "")).files).toMatchObject([{ path: "MOVED.md", old_path: "README.md", status: "renamed" }]);

    await revert_file(context, "run", "", "MOVED.md");
    expect(existsSync(join(worktree, "MOVED.md"))).toBe(false);
    rmSync(join(worktree, "README.md"));
    const deleted = (await read_changes(context, "run", "")).files;
    expect(deleted).toMatchObject([{ path: "README.md", status: "removed", fingerprint: "deleted" }]);

    await revert_file(context, "run", "", "README.md");
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("# Test\nline\n");
    rmSync(checkout, { recursive: true, force: true });
  });

  it("says why there is nothing to show without a checkout, a worktree or a run's start", async () => {
    const { checkout, database, store, item_id } = setup();
    const item = store.get_item(item_id);

    expect((await read_changes({ database, item, repositories: {} }, "item", "")).problem).toContain("does not know where");
    expect((await read_changes({ database, item: { ...item, branch: "" }, repositories: { [repository]: checkout } }, "item", "")).problem).toContain("no worktree yet");
    expect((await read_changes({ database, item, repositories: { [repository]: checkout } }, "run", "")).problem).toContain("no commit it started from");
    await expect(revert_file({ database, item, repositories: {} }, "item", "", "README.md")).rejects.toThrow("does not know where");
    expect(await read_run_changes(database, [], {})).toEqual({});
    rmSync(checkout, { recursive: true, force: true });
  });
});
