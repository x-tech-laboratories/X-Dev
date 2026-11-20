import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { watch_run_notices } from "../src/daemon/run_notices.ts";
import { desktop_setting_defaults, read_desktop_settings, type DesktopSettings } from "../src/shared/desktop.ts";
import type { PullRequest } from "../src/shared/items/github.ts";
import { checks_notices, pull_request_snapshots, run_notices, watch_notices, type RunSnapshot, type SeenRun } from "../src/shared/runs/notices.ts";
import { insert_run, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

const label = (stage: string) => stage[0]!.toUpperCase() + stage.slice(1);

function snapshot(changes: Partial<RunSnapshot>): RunSnapshot {
  return { id: "r1", item_id: "i1", item_title: "Runs page", stage: "plan", state: "running", proposals: 0, summary: "", error: "", question: "", awaiting: "", ...changes };
}

// ============================================================================
// Rules
// ============================================================================

describe("run notices", () => {
  it("say nothing of a run seen for the first time, and remember it while it runs", () => {
    const result = run_notices(new Map(), [snapshot({ proposals: 1 })], label);
    expect(result.notices).toEqual([]);
    expect(result.seen.get("r1")).toEqual({ state: "running", proposals_before: 1, awaiting: "" });
  });

  it("tell once when a running run starts waiting for a tool call to be approved", () => {
    const first = run_notices(new Map(), [snapshot({})], label);
    const asked = run_notices(first.seen, [snapshot({ awaiting: "Bash" })], label);
    expect(asked.notices).toEqual([{ kind: "run_approval", key: "item-i1", title: "Plan waits for approval: Runs page", body: "Allow or deny Bash to let the run go on.", url: "x-dev://items/i1/r1" }]);
    expect(run_notices(asked.seen, [snapshot({ awaiting: "Bash" })], label).notices).toEqual([]);
  });

  it("tell of a run that finished, failed or asked, keyed by its item and linking to it", () => {
    const seen = new Map<string, SeenRun>([["r1", { state: "running", proposals_before: 0 }]]);

    expect(run_notices(seen, [snapshot({ state: "done", summary: "Planned it" })], label).notices).toEqual([{ kind: "run_finished", key: "item-i1", title: "Plan finished: Runs page", body: "Planned it", url: "x-dev://items/i1/r1" }]);
    expect(run_notices(seen, [snapshot({ state: "failed", error: "A gate failed: leftovers.\nmore" })], label).notices[0]).toMatchObject({ kind: "run_failed", body: "A gate failed: leftovers." });
    expect(run_notices(seen, [snapshot({ state: "waiting", question: "Which board?" })], label).notices[0]).toMatchObject({ kind: "run_asked", title: "Plan has questions: Runs page", body: "Which board?" });
    expect(run_notices(seen, [snapshot({ state: "stopped" })], label).notices).toEqual([]);
  });

  it("tell of the proposals a run made while it ran", () => {
    const first = run_notices(new Map(), [snapshot({ proposals: 1 })], label);
    const second = run_notices(first.seen, [snapshot({ proposals: 2 })], label);
    const ended = run_notices(second.seen, [snapshot({ state: "done", proposals: 3 })], label);

    expect(ended.notices.map((notice) => notice.kind)).toEqual(["run_finished", "run_proposed"]);
    expect(ended.notices[1]).toMatchObject({ key: "proposals-i1", title: "Plan proposed 2 items: Runs page", url: "x-dev://board" });
    expect(ended.seen.size).toBe(0);
  });
});

describe("pull request notices", () => {
  const pull_request = (buckets: PullRequest["checks"][number]["bucket"][]): PullRequest => ({ number: 12, url: "https://github.com/o/r/pull/12", state: "open", draft: false, changed_at: "", checks: buckets.map((bucket, index) => ({ name: `check ${index}`, workflow: "", bucket, link: "" })) });

  it("tell once of checks that were running and have all finished, passed or failed", () => {
    const first = checks_notices(new Set(), [{ item_id: "i1", item_title: "Runs page", pull_request: pull_request(["pass", "pending"]) }]);
    expect(first.notices).toEqual([]);

    const passed = checks_notices(first.running, [{ item_id: "i1", item_title: "Runs page", pull_request: pull_request(["pass", "pass"]) }]);
    expect(passed.notices).toEqual([{ kind: "checks_finished", key: "checks-i1", title: "Checks passed on #12: Runs page", body: "All 2 checks passed.", url: "x-dev://items/i1" }]);
    expect(checks_notices(passed.running, [{ item_id: "i1", item_title: "Runs page", pull_request: pull_request(["pass", "pass"]) }]).notices).toEqual([]);

    const failed = checks_notices(first.running, [{ item_id: "i1", item_title: "Runs page", pull_request: pull_request(["pass", "fail"]) }]);
    expect(failed.notices[0]).toMatchObject({ title: "Checks failed on #12: Runs page", body: "1 of 2 checks failed." });
    expect(checks_notices(new Set(["i1"]), [{ item_id: "i1", item_title: "Runs page", pull_request: null }]).notices).toEqual([]);
  });
});

// ============================================================================
// The daemon
// ============================================================================

describe("the daemon's run notices", () => {
  function setup(settings: Partial<DesktopSettings> = {}) {
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const store = bind_methods(() => database, () => undefined);
    const item_id = store.save_item({ title: "Runs page", repository: "x-tech-laboratories/X-Dev" });
    const run_id = insert_run(database, { item_id, stage: "plan", model: "", effort: "", session_id: "s", start_commit: "", status_before: "{}", input: "", started_at: "2026-11-20T10:00:00.000Z" });
    const notifier = { show: vi.fn(async () => undefined) };
    const watch = watch_run_notices({ database: () => database, notifier, settings: () => ({ ...desktop_setting_defaults, ...settings }), stage_label: label });
    return { database, run_id, notifier, watch };
  }

  it("show a notification once a run already under way finishes", () => {
    const { database, run_id, notifier, watch } = setup();
    watch.check();
    expect(notifier.show).not.toHaveBeenCalled();

    update_run(database, run_id, { state: "done", report: "## Plan handoff\n**Next:** specify\n**Done:** - planned it" });
    watch.check();
    watch.check();

    expect(notifier.show).toHaveBeenCalledTimes(1);
    expect(notifier.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Plan finished: Runs page", body: "planned it", key: expect.stringMatching(/^item-/), icon: "app" }));
  });

  it("show a pull request's checks finishing once they were seen running", () => {
    const { database, notifier, watch } = setup();
    const set_checks = (bucket: string) => database.prepare("UPDATE items SET pull_request = ?").run(JSON.stringify({ number: 3, url: "https://github.com/o/r/pull/3", state: "open", checks: [{ name: "test", bucket }] }));
    set_checks("pending");
    watch.check();
    set_checks("pass");
    watch.check();
    expect(notifier.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Checks passed on #3: Runs page" }));
  });

  it("show only the kinds this computer has switched on", () => {
    const { database, run_id, notifier, watch } = setup({ notify_run_asked: false });
    update_run(database, run_id, { state: "waiting", questions: [{ question: "Which?", why: "", choices: [] }] });
    watch.check();
    expect(notifier.show).not.toHaveBeenCalled();
  });

  it("are all on unless switched off, a damaged setting read as on", () => {
    expect(read_desktop_settings({ notify_run_failed: false, notify_run_asked: "yes" })).toMatchObject({ notify_run_finished: true, notify_run_failed: false, notify_run_asked: true, notify_run_proposed: true, show_tray_icon: true });
  });
});

// ============================================================================
// Watching from elsewhere
// ============================================================================

describe("notices from a daemon elsewhere", () => {
  it("learn what runs first, then tell of a run that asked, by the kinds switched on, asking after the runs seen before", async () => {
    let runs = [snapshot({})];
    const read_runs = vi.fn(async () => runs);
    const show = vi.fn();
    const watch = watch_notices({ read_runs, read_pull_requests: async () => [], stage_label: label, is_on: (kind) => kind !== "run_failed", show });

    await watch.check();
    expect(show).not.toHaveBeenCalled();
    runs = [snapshot({ state: "waiting", question: "Lanes or tabs?" })];
    await watch.check();

    expect(read_runs).toHaveBeenLastCalledWith(["r1"]);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: "run_asked", title: "Plan has questions: Runs page", body: "Lanes or tabs?", url: "x-dev://items/i1/r1" }));
  });

  it("tell of a waiting run that was answered and ended between two looks, its running passed over", async () => {
    let runs = [snapshot({ state: "waiting", question: "Lanes or tabs?" })];
    const read_runs = vi.fn(async () => runs);
    const show = vi.fn();
    const watch = watch_notices({ read_runs, read_pull_requests: async () => [], stage_label: label, is_on: () => true, show });

    await watch.check();
    runs = [snapshot({ state: "failed", error: "A gate failed: status." })];
    await watch.check();
    await watch.check();

    expect(read_runs).toHaveBeenNthCalledWith(2, ["r1"]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: "run_failed", title: "Plan failed: Runs page", body: "A gate failed: status." }));
  });

  it("leave out the kinds switched off", async () => {
    let runs = [snapshot({})];
    const show = vi.fn();
    const watch = watch_notices({ read_runs: async () => runs, read_pull_requests: async () => [], stage_label: label, is_on: async () => false, show });

    await watch.check();
    runs = [snapshot({ state: "failed", error: "A gate failed." })];
    await watch.check();

    expect(show).not.toHaveBeenCalled();
  });

  it("read the open items' pull requests from the items", () => {
    const read = vi.fn(() => null);
    const items = [
      { id: "i1", title: "Open", pull_request: "{}", closed_at: null },
      { id: "i2", title: "None yet", pull_request: "", closed_at: null },
      { id: "i3", title: "Closed", pull_request: "{}", closed_at: "2026-11-20T10:00:00Z" },
    ];

    expect(pull_request_snapshots(items, read)).toEqual([{ item_id: "i1", item_title: "Open", pull_request: null }]);
  });
});
