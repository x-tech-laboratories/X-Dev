import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { create_github_sync, type GitHubSync } from "../src/server/github_sync.ts";
import { status_marker } from "../src/shared/items/github.ts";
import { insert_run, set_item_fields, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

const fake_gh = join(import.meta.dirname, "fixtures", "fake_gh.mjs");

interface FakeIssue {
  state: string;
  labels: string[];
  body: string;
  comments: { id: number; body: string }[];
}

interface FakeGitHub {
  offline?: boolean;
  issues: Record<string, FakeIssue>;
  labels: string[];
  pulls: { number: number; url: string; state: string; isDraft: boolean; head: string }[];
  checks: Record<string, { name: string; bucket: string; link: string; workflow: string }[]>;
  next_comment_id: number;
  calls: string[][];
}

// A GitHub in a JSON file that the fake gh reads and writes, with issue #7 open.
function fake_github() {
  const file = join(mkdtempSync(join(tmpdir(), "x-dev-github-")), "github.json");
  const start: FakeGitHub = { issues: { "7": { state: "OPEN", labels: ["bug"], body: "What it asks for.\n", comments: [] } }, labels: ["bug"], pulls: [], checks: {}, next_comment_id: 100, calls: [] };
  writeFileSync(file, JSON.stringify(start));
  process.env.FAKE_GH_DATA = file;
  const read = (): FakeGitHub => JSON.parse(readFileSync(file, "utf8")) as FakeGitHub;
  const change = (edit: (data: FakeGitHub) => void) => {
    const data = read();
    edit(data);
    writeFileSync(file, JSON.stringify(data));
  };
  return { read, change, issue: () => read().issues["7"]! };
}

let sync: GitHubSync | null = null;

afterEach(() => {
  sync?.stop();
  delete process.env.FAKE_GH_DATA;
});

function setup() {
  const github = fake_github();
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const after_write = vi.fn();
  sync = create_github_sync({ database: () => database, program: () => fake_gh, after_write, stage_label: (id) => id.charAt(0).toUpperCase() + id.slice(1), checks_interval: 0.05, idle_interval: 60, now: () => "2026-11-20T10:00:00.000Z" });
  const item_id = store.save_item({ title: "Board with swimlanes", repository: "owner/repo", issue_number: 7, stage: "specify" });
  store.update_item_status(item_id, { goal: "Lanes on the board." });
  const add_run = (changes: Parameters<typeof update_run>[2], stage = "plan", started_at = "2026-11-20T09:00:00.000Z") => {
    const id = insert_run(database, { item_id, stage, model: "", effort: "", session_id: "s", start_commit: "", status_before: "{}", input: "", started_at });
    update_run(database, id, changes);
    return id;
  };
  return { github, database, store, sync, item_id, add_run, after_write };
}

const report = "## Plan handoff\n**Next:** specify\n**Done:** - planned";

describe("mirroring an item to its issue", () => {
  it("posts each report as a comment, puts the stage label on, and keeps the status sheet at the top of the body", async () => {
    const { github, store, sync, item_id, add_run } = setup();
    add_run({ state: "done", report, next: "specify" });

    expect(await sync.sync_item(item_id)).toBe("");

    const issue = github.issue();
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.body).toContain("<!-- stage-handoff -->");
    expect(issue.comments[0]!.body).toContain("## Plan handoff");
    expect(issue.labels).toEqual(["bug", "stage:specify"]);
    expect(github.read().labels).toContain("stage:specify");
    expect(issue.body.startsWith(status_marker)).toBe(true);
    expect(issue.body).toContain("Lanes on the board.");
    expect(issue.body.endsWith(`${status_marker}\n\nWhat it asks for.\n`)).toBe(true);
    expect(store.get_item_github(item_id).mirror).toMatchObject({ labels: ["stage:specify"], problem: "", synced_at: "2026-11-20T10:00:00.000Z" });
  });

  it("asks nothing of GitHub when nothing changed", async () => {
    const { github, sync, item_id, add_run } = setup();
    add_run({ state: "done", report, next: "specify" });
    await sync.sync_item(item_id);
    const calls = github.read().calls.length;

    await sync.sync_item(item_id);

    expect(github.read().calls).toHaveLength(calls);
  });

  it("edits a changed report's comment in place, marks a discarded run's, and posts again one deleted on GitHub", async () => {
    const { github, store, database, sync, item_id, add_run } = setup();
    const run_id = add_run({ state: "done", report, next: "specify" });
    await sync.sync_item(item_id);

    store.update_run_report(run_id, `${report}\n**Decisions:** lanes`);
    await sync.sync_item(item_id);
    expect(github.issue().comments).toEqual([{ id: 100, body: expect.stringContaining("**Decisions:** lanes") }]);

    update_run(database, run_id, { state: "discarded" });
    await sync.sync_item(item_id);
    expect(github.issue().comments[0]!.body).toContain("This Plan run was discarded in X-Dev");

    github.change((data) => (data.issues["7"]!.comments = []));
    update_run(database, run_id, { state: "done" });
    await sync.sync_item(item_id);
    expect(github.issue().comments).toEqual([{ id: 101, body: expect.stringContaining("## Plan handoff") }]);
  });

  it("adds a gate's override reason with the report, and names gates still failing", async () => {
    const { github, store, sync, item_id, add_run } = setup();
    const run_id = add_run({ state: "failed", report, next: "specify", gates: [{ gate: "leftovers", outcome: "failed", findings: ["x"] }] });
    await sync.sync_item(item_id);
    expect(github.issue().comments[0]!.body).toContain("**Gates failed:** leftovers");

    store.override_gate(run_id, "leftovers", "The log is the feature.");
    await sync.sync_item(item_id);

    expect(github.issue().comments[0]!.body).toContain("**Gate passed over:** leftovers: The log is the feature.");
    expect(github.issue().comments[0]!.body).not.toContain("**Gates failed:**");
  });

  it("marks needs-input while a run waits on the user, and moves the stage label along", async () => {
    const { github, database, sync, item_id, add_run } = setup();
    set_item_fields(database, item_id, { stage: "plan" });
    const run_id = add_run({ state: "waiting" });
    await sync.sync_item(item_id);
    expect(github.issue().labels).toEqual(["bug", "stage:plan", "stage:needs-input"]);

    update_run(database, run_id, { state: "done", report, next: "specify" });
    set_item_fields(database, item_id, { stage: "specify" });
    await sync.sync_item(item_id);
    expect(github.issue().labels).toEqual(["bug", "stage:specify"]);
  });

  it("keeps a failure on the item without throwing, and catches up on the next try", async () => {
    const { github, store, sync, item_id, add_run, after_write } = setup();
    add_run({ state: "done", report, next: "specify" });
    github.change((data) => (data.offline = true));

    const problem = await sync.sync_item(item_id);

    expect(problem).toContain("error connecting to api.github.com");
    expect(store.get_item_github(item_id).mirror.problem).toBe(problem);
    expect(after_write).toHaveBeenCalled();

    github.change((data) => (data.offline = false));
    expect(await sync.sync_item(item_id)).toBe("");
    expect(github.issue().comments).toHaveLength(1);
    expect(store.get_item_github(item_id).mirror.problem).toBe("");
  });

  it("never posts a report or sheet that holds a secret", async () => {
    const { github, store, sync, item_id, add_run } = setup();
    // Made from pieces so no whole token sits in the file.
    const token = ["gh", "p_", "x".repeat(36)].join("");
    add_run({ state: "done", report: `${report}\n${token}`, next: "specify" });
    store.update_item_status(item_id, { links: token });

    const problem = await sync.sync_item(item_id);

    expect(problem).toContain("Not posted, since the Plan report holds a GitHub token.");
    expect(problem).toContain("The status sheet was not mirrored, since the status sheet holds a GitHub token.");
    expect(github.issue().comments).toEqual([]);
    expect(github.issue().body).toBe("What it asks for.\n");
    expect(github.issue().labels).toEqual(["bug", "stage:specify"]);
  });

  it("closes the issue once the item is done, and only once", async () => {
    const { github, database, sync, item_id } = setup();
    set_item_fields(database, item_id, { stage: "done" });

    await sync.sync_item(item_id);
    expect(github.issue().state).toBe("CLOSED");

    github.change((data) => (data.issues["7"]!.state = "OPEN"));
    await sync.sync_item(item_id);
    expect(github.issue().state).toBe("OPEN");
  });

  it("leaves items with no issue and proposals alone", async () => {
    const { github, store, sync } = setup();
    const id = store.save_item({ title: "No issue yet", repository: "owner/repo" });
    expect(await sync.sync_item(id)).toBe("");
    expect(await sync.sync_item("missing")).toBe("");
    expect(github.read().calls).toEqual([]);
  });
});

describe("the pull request", () => {
  function with_pull_request(bucket: string) {
    const context = setup();
    set_item_fields(context.database, context.item_id, { branch: "worktree-item-7", stage: "review" });
    context.github.change((data) => {
      data.pulls = [{ number: 12, url: "https://github.com/owner/repo/pull/12", state: "OPEN", isDraft: false, head: "worktree-item-7" }];
      data.checks = { "12": [{ name: "test", bucket, link: "https://github.com/owner/repo/actions/runs/1", workflow: "CI" }] };
    });
    return context;
  }

  it("is found from the item's branch with its checks, and refreshed while open", async () => {
    const { github, store, sync, item_id } = with_pull_request("pending");
    await sync.sync_item(item_id);
    expect(store.get_item_github(item_id).pull_request).toBeNull();

    await sync.sync_item(item_id, { find_pull_request: true });
    expect(store.get_item_github(item_id).pull_request).toMatchObject({ number: 12, state: "open", checks: [{ name: "test", bucket: "pending", workflow: "CI" }] });

    github.change((data) => {
      data.checks["12"]![0]!.bucket = "pass";
      data.pulls[0]!.state = "MERGED";
    });
    await sync.sync_item(item_id);
    expect(store.get_item_github(item_id).pull_request).toMatchObject({ state: "merged", checks: [{ bucket: "pass" }] });

    const calls = github.read().calls.length;
    await sync.sync_item(item_id);
    expect(github.read().calls).toHaveLength(calls);
  });

  it("moves on a run held only by its ci gate once the checks pass", async () => {
    const { github, store, sync, item_id, add_run } = with_pull_request("pending");
    const run_id = add_run({ state: "failed", report: "## Review handoff\n**Next:** release", next: "release", gates: [{ gate: "report", outcome: "passed", findings: [] }, { gate: "ci", outcome: "failed", findings: ["still running"] }] }, "review");
    await sync.sync_item(item_id, { find_pull_request: true });
    expect(store.get_run(run_id).state).toBe("failed");

    github.change((data) => (data.checks["12"]![0]!.bucket = "pass"));
    await sync.sync_item(item_id);

    expect(store.get_run(run_id)).toMatchObject({ state: "done", gates: [{ gate: "report" }, { gate: "ci", outcome: "passed" }] });
    expect(store.get_item(item_id).stage).toBe("release");
    expect(github.issue().labels).toContain("stage:release");
  });

  it("is polled while its checks run", async () => {
    const { github, store, sync, item_id } = with_pull_request("pending");
    await sync.sync_item(item_id, { find_pull_request: true });
    github.change((data) => (data.checks["12"]![0]!.bucket = "fail"));

    sync.start();

    await vi.waitFor(() => expect(store.get_item_github(item_id).pull_request?.checks[0]?.bucket).toBe("fail"), { timeout: 5000 });
  });
});
