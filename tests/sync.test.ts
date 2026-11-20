import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { insert_run, propose, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, features, open_store, sync_engine } from "../src/shared/store.ts";

function open_device(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return database;
}

// Sends one device's unpushed changes to another, as an exchange through the server does.
function push(from: DatabaseSync, to: DatabaseSync): void {
  const outgoing = sync_engine.collect_unpushed_changes(from);
  sync_engine.write_state(from, { pushed_seq: outgoing.up_to_seq });
  sync_engine.apply_changes(to, outgoing.changes);
}

describe("sync between devices", () => {
  it("carries items, their status sheets and their closing", () => {
    const laptop = open_device();
    const desktop = open_device();
    const on_laptop = bind_methods(() => laptop, () => undefined);
    const on_desktop = bind_methods(() => desktop, () => undefined);

    const id = on_laptop.save_item({ title: "Board with swimlanes", repository: "x-tech-laboratories/X-Dev", issue_number: 4 });
    on_laptop.update_item_status(id, { current_state: "Planned." });
    push(laptop, desktop);
    on_desktop.close_item(id);
    push(desktop, laptop);

    expect(on_desktop.get_item(id)).toMatchObject({ title: "Board with swimlanes", issue_number: 4, status: { current_state: "Planned." } });
    expect(on_laptop.list_items()).toEqual([]);
    expect(on_laptop.list_items(true)[0]!.closed_at).not.toBeNull();
  });

  it("carries runs with their reports, questions and answers, and proposals, until both copies match", () => {
    const daemon = open_device();
    const laptop = open_device();
    const on_daemon = bind_methods(() => daemon, () => undefined);
    const on_laptop = bind_methods(() => laptop, () => undefined);
    const id = on_daemon.save_item({ title: "Board with swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    const run_id = insert_run(daemon, { item_id: id, stage: "plan", model: "fable", effort: "high", session_id: "session", start_commit: "abc", status_before: "{}", input: "Plan it.", started_at: "2026-11-20T10:00:00Z" });
    update_run(daemon, run_id, { state: "waiting", questions: [{ question: "Lanes or tabs?", why: "Both fit.", choices: ["Lanes", "Tabs"] }] });
    propose(daemon, { item_id: id, run_id }, { title: "Keyboard moves between lanes", why: "Seen while planning." }, "2026-11-20T10:05:00Z");
    push(daemon, laptop);

    // Another copy adds notes while the daemon takes the answer and finishes the report.
    on_laptop.save_item_notes(id, "Use lanes.");
    update_run(daemon, run_id, { state: "done", report: "## Plan handoff\n**Next:** specify\n**Done:**\n- Planned lanes.", answers: "Lanes" });
    push(laptop, daemon);
    push(daemon, laptop);

    for (const copy of [on_daemon, on_laptop]) {
      expect(copy.get_run(run_id)).toMatchObject({ state: "done", answers: "Lanes", questions: [{ question: "Lanes or tabs?" }] });
      expect(copy.get_item(id).notes).toBe("Use lanes.");
      expect(copy.list_proposals().map((proposal) => proposal.title)).toEqual(["Keyboard moves between lanes"]);
    }
    expect(on_laptop.list_stage_runs()).toEqual(on_daemon.list_stage_runs());
  });

  it("holds no stage files, worktrees or runner settings, which stay on the computer that runs the agents", () => {
    const synced = features.flatMap((feature) => feature.tables.map((table) => table.name));

    expect(synced).toEqual(expect.arrayContaining(["items", "runs"]));
    expect(synced.filter((name) => /stage|worktree|runner/.test(name))).toEqual([]);
  });
});
