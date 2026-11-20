import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { empty_status } from "../src/shared/items/model.ts";
import { answers_input, append_output, build_run_input, check_questions, output_limit, parse_report, read_stream_line } from "../src/shared/runs/model.ts";
import { insert_run, latest_report, propose, title_likeness, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

function open_methods() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return { database, store: bind_methods(() => database, () => undefined) };
}

const item = { title: "Board with swimlanes", repository: "x-tech-laboratories/X-Dev" };
const report = "## Plan handoff\n**Next:** specify\n**Done:** - planned";

function add_run(database: DatabaseSync, item_id: string, started_at: string) {
  return insert_run(database, { item_id, stage: "plan", model: "", effort: "", session_id: "s", start_commit: "", status_before: "{}", input: "", started_at });
}

// ============================================================================
// Rules
// ============================================================================

describe("a report", () => {
  it("is the last handoff block in the message, with the next stage it names", () => {
    expect(parse_report(`Thinking.\n\n## Draft handoff\n**Next:** plan\n\n${report}`)).toEqual({ text: report, next: "specify" });
    expect(parse_report("## Plan handoff\n**Next:** `needs-input`")!.next).toBe("needs-input");
  });

  it("is missing without a handoff heading or a next stage", () => {
    expect(parse_report("All done.")).toBeNull();
    expect(parse_report("## Plan handoff\n**Done:** - planned")).toBeNull();
  });
});

describe("a run's input", () => {
  it("holds the item, its status sheet, the latest report and the user's notes", () => {
    const { store } = open_methods();
    const saved = store.get_item(store.save_item({ ...item, body: "One lane per item.", issue_number: 4 }));
    const input = build_run_input({
      item: { ...saved, branch: "worktree-item-4", status: { ...empty_status(), goal: "Lanes." } },
      stage_label: "Plan",
      worktree: "/repo/.claude/worktrees/item-4",
      issue_url: "https://github.com/x-tech-laboratories/X-Dev/issues/4",
      latest_report: report,
      notes: "Keep it small.",
    });

    expect(input).toContain("You are running the Plan stage for this item.");
    expect(input).toContain("- Issue: https://github.com/x-tech-laboratories/X-Dev/issues/4");
    expect(input).toContain("One lane per item.");
    expect(input).toContain("### Goal\n\nLanes.");
    expect(input).toContain("### Decisions\n\nNothing yet.");
    expect(input).toContain(report);
    expect(input).toContain("Keep it small.");
  });

  it("hands a resumed session the questions it asked with the answers", () => {
    expect(answers_input([{ question: "Lanes or columns?", why: "", choices: [] }], " Lanes. ")).toContain("You asked:\n1. Lanes or columns?\n\nTheir answers:\nLanes.");
  });
});

describe("the agent's stream", () => {
  it("becomes transcript lines, tools named with what they ran on", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] } });
    expect(read_stream_line(line)).toEqual({ lines: ["Looking.", "→ Read: src/a.ts"], result: null });
    expect(read_stream_line(JSON.stringify({ type: "system", subtype: "init" }))).toEqual({ lines: [], result: null });
    expect(read_stream_line("not json")).toEqual({ lines: ["not json"], result: null });
  });

  it("gives the result with its cost", () => {
    const line = JSON.stringify({ type: "result", result: report, is_error: false, total_cost_usd: 0.4, session_id: "s1" });
    expect(read_stream_line(line).result).toEqual({ text: report, is_error: false, cost_usd: 0.4, session_id: "s1" });
  });

  it("keeps the newest part of a transcript that runs over", () => {
    const long = append_output("x".repeat(output_limit), ["newest"]);
    expect(long.length).toBeLessThanOrEqual(output_limit + 2);
    expect(long.endsWith("newest")).toBe(true);
    expect(long.startsWith("…\n")).toBe(true);
  });
});

describe("questions", () => {
  it("are checked as an agent sends them", () => {
    expect(check_questions([{ question: " Lanes? ", choices: ["Yes", 2] }])).toEqual([{ question: "Lanes?", why: "", choices: ["Yes", "2"] }]);
    expect(() => check_questions([])).toThrow("ask at least one question");
    expect(() => check_questions([{ why: "no text" }])).toThrow("question 1 has no text");
  });
});

// ============================================================================
// Store
// ============================================================================

describe("proposals", () => {
  it("wait in the inbox, linked to where they came from, until taken or dropped", () => {
    const { database, store } = open_methods();
    const source = store.save_item(item);
    const run = add_run(database, source, "2026-11-20T10:00:00.000Z");

    const first = propose(database, { item_id: source, run_id: run }, { title: "Faster drawing", why: "It lags.", where: "src/web/board.tsx" });
    const second = propose(database, { item_id: source, run_id: run }, { title: "Export the board", kind: "feature", why: "For reports." });

    expect(store.list_proposals().map((each) => each.title).sort()).toEqual(["Export the board", "Faster drawing"]);
    expect(store.get_item(first.item_id)).toMatchObject({ stage: "proposed", source_item_id: source, source_run_id: run, body: 'Proposed from "Board with swimlanes": It lags. Seen in src/web/board.tsx.' });
    store.accept_proposal(first.item_id);
    store.drop_proposal(second.item_id);

    expect(store.list_proposals()).toEqual([]);
    expect(store.get_item(first.item_id).stage).toBe("triage");
    expect(store.get_item(second.item_id).closed_at).not.toBeNull();
    expect(() => store.accept_proposal(source)).toThrow("that item is not a proposal");
  });

  it("join an open item whose title is close, rather than repeat it", () => {
    const { database, store } = open_methods();
    const source = store.save_item(item);
    const open = store.save_item({ title: "Faster board drawing", repository: item.repository });

    const result = propose(database, { item_id: source, run_id: add_run(database, source, "2026-11-20T10:00:00.000Z") }, { title: "Board drawing faster", why: "It lags." });

    expect(result).toEqual({ item_id: open, joined: true });
    expect(store.get_item(open).body).toContain("It lags.");
    expect(title_likeness("Faster board drawing", "Export the board")).toBeLessThan(0.6);
    expect(() => propose(database, { item_id: source, run_id: "r" }, { title: "Something", why: " " })).toThrow("say why the proposal matters");
  });
});

describe("runs", () => {
  it("list newest first, and the next run starts from the latest finished report", () => {
    const { database, store } = open_methods();
    const id = store.save_item(item);
    const first = add_run(database, id, "2026-11-20T10:00:00.000Z");
    update_run(database, first, { state: "done", report });
    const second = add_run(database, id, "2026-11-20T11:00:00.000Z");
    update_run(database, second, { state: "discarded", report: "## Bad handoff\n**Next:** done" });

    expect(store.list_runs(id).map((run) => run.id)).toEqual([second, first]);
    expect(store.list_recent_runs(1).map((run) => run.id)).toEqual([second]);
    expect(latest_report(database, id)).toBe(report);
  });

  it("let the user change a finished run's report and leave notes for the next run", () => {
    const { database, store } = open_methods();
    const id = store.save_item(item);
    const run = add_run(database, id, "2026-11-20T10:00:00.000Z");

    expect(() => store.update_run_report(run, "x")).toThrow("only a finished run's report can be changed");
    update_run(database, run, { state: "done", report });
    store.update_run_report(run, " ## Plan handoff\n**Next:** implement ");
    store.save_item_notes(id, " Skip Specify. ");

    expect(store.get_run(run).report).toBe("## Plan handoff\n**Next:** implement");
    expect(store.get_item(id).notes).toBe("Skip Specify.");
    expect(() => store.get_run("missing")).toThrow("no run missing");
  });
});
