// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { create_stage_files } from "../src/server/stage_files.ts";
import { report_summary } from "../src/shared/runs/model.ts";
import { runner_setting_defaults, type RunnerMethods } from "../src/shared/runs/runner.ts";
import { insert_run, update_run } from "../src/shared/runs/store.ts";
import type { StagesMethods } from "../src/shared/stages/model.ts";
import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { page, set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";
import { is_send_back } from "../src/web/board/index.tsx";

function as_client(methods: object): unknown {
  return Object.fromEntries(Object.entries(methods as Record<string, (...args: unknown[]) => unknown>).map(([name, call]) => [name, async (...args: unknown[]) => call(...args)]));
}

function fake_page({ running = false } = {}) {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  stages.add_default_stages();
  const runner = {
    get_runner: vi.fn(() => ({ settings: runner_setting_defaults, running_run_id: running ? "busy" : null })),
    start_run: vi.fn(async () => "run-1"),
    retry_run: vi.fn(async () => "run-2"),
    stop_run: vi.fn(),
    interrupt_run: vi.fn(async () => undefined),
    answer_run: vi.fn(),
    discard_run: vi.fn(async () => undefined),
    list_run_changes: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { additions: 18, deletions: 2 }]))),
    get_run: vi.fn(),
    get_github: vi.fn(async () => ({ signed_in: true, account: "someone", problem: "" })),
  };
  set_page_api({
    host: "desktop",
    calls: as_client(store) as Client<DevMethods>,
    device: null,
    stages: as_client(stages) as Client<StagesMethods>,
    runner: as_client(runner) as Client<RunnerMethods>,
    on_change: () => () => undefined,
  });
  return { database, store, runner };
}

function add_run(database: DatabaseSync, item_id: string, stage: string, changes: Parameters<typeof update_run>[2], started_at = "2026-11-20T10:00:00.000Z") {
  const id = insert_run(database, { item_id, stage, model: "opus", effort: "", session_id: "s", start_commit: "", status_before: "{}", input: "", started_at });
  update_run(database, id, changes);
  return id;
}

async function card(title: string) {
  return screen.findByRole("article", { name: title });
}

// The board card holding an item's card, which takes focus, opens and drags.
function board_card(title: string): HTMLElement {
  return screen.getByRole("article", { name: title }).closest(".board-card") as HTMLElement;
}

// The column head over the cell a card sits in.
function column_of(title: string): string {
  const cell = board_card(title).closest("[role=gridcell]")!;
  const cells = [...cell.parentElement!.querySelectorAll(":scope > [role=gridcell]")];
  const heads = screen.getAllByRole("columnheader").filter((head) => head.classList.contains("board-column-head"));
  return heads[cells.indexOf(cell)]!.querySelector(".board-column-label")!.textContent!;
}

// The board's cell under a column head, in its only row of cards.
function cell_under(label: string): HTMLElement {
  const heads = screen.getAllByRole("columnheader").filter((head) => head.classList.contains("board-column-head"));
  const index = heads.findIndex((head) => head.querySelector(".board-column-label")!.textContent === label);
  return screen.getAllByRole("gridcell")[index]!;
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

afterEach(cleanup);

describe("a report's summary", () => {
  it("is the first thing the report says it did", () => {
    expect(report_summary("## Plan handoff\n**Next:** specify\n**Done:** - Planned the lanes\n- Checked X-Libs")).toBe("Planned the lanes");
    expect(report_summary("## Plan handoff\n**Next:** specify\n**Done:**\n- Planned the lanes")).toBe("Planned the lanes");
    expect(report_summary("Just text.")).toBe("Just text.");
  });
});

describe("the board", () => {
  it("is the page X-Dev opens on, with a column per stage and each item's card in the column of the stage it is at", async () => {
    const { store } = fake_page();
    store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan", issue_number: 4 });
    store.save_item({ title: "Board widget", repository: "x-tech-laboratories/X-Libs", stage: "triage" });
    render(<App />);

    expect(await screen.findByRole("grid", { name: "Board" })).toBeTruthy();
    expect(column_of("Swimlanes")).toBe("Plan");
    expect(within(await card("Swimlanes")).getByText("X-Dev #4")).toBeTruthy();
    expect(column_of("Board widget")).toBe("Triage");
    expect(screen.getAllByRole("columnheader").map((head) => head.querySelector(".board-column-label")?.textContent)).toEqual(["Triage", "Plan", "Specify", "Implement", "Verify", "Extract", "Docs", "Review", "Release", "Deploy", "Close"]);
    expect(screen.getAllByRole("columnheader")[1]!.textContent).toBe("Plan1");
  });

  it("merges the card with its stage's latest run: state, summary, model, changed lines, cost and gates", async () => {
    const { database, store } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
    add_run(database, id, "triage", { state: "done" });
    add_run(database, id, "implement", {
      state: "done",
      cost_usd: 0.13,
      report: "## Implement handoff\n**Next:** verify\n**Done:** - Built the lanes",
      gates: [
        { gate: "tests-pass", outcome: "passed", findings: [] },
        { gate: "leftovers", outcome: "warning", findings: [] },
      ],
    });
    render(<App />);

    const swimlanes = await card("Swimlanes");
    expect(within(swimlanes).getByText("Built the lanes")).toBeTruthy();
    expect(within(swimlanes).getByText("Done")).toBeTruthy();
    expect(within(swimlanes).getByText("opus")).toBeTruthy();
    expect(within(swimlanes).getByText("$0.13")).toBeTruthy();
    expect(await within(swimlanes).findByText("+18")).toBeTruthy();
    expect(within(swimlanes).getByText(/1 passed/)).toBeTruthy();
    expect(within(swimlanes).getByText(/leftovers/)).toBeTruthy();
    expect(within(swimlanes).getByRole("listitem", { name: "Triage: done" })).toBeTruthy();
    expect(within(swimlanes).getByRole("listitem", { name: "Plan: skipped" })).toBeTruthy();
    expect(within(swimlanes).getByRole("listitem", { name: "Review: not reached" })).toBeTruthy();
  });

  it("runs the item's stage from its card, and on another model with Review warned off Implement's", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "review" });
    add_run(database, id, "implement", { state: "done" });
    render(<App />);

    const swimlanes = await card("Swimlanes");
    fireEvent.click(within(swimlanes).getByRole("button", { name: "Run Review on Swimlanes" }));
    await waitFor(() => expect(runner.start_run).toHaveBeenCalledWith(id, {}));

    fireEvent.click(within(swimlanes).getByRole("button", { name: "Model…" }));
    const dialog = await screen.findByRole("dialog", { name: "Run Review on Another Model" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Model for this run" }), { target: { value: "opus" } });
    expect(within(dialog).getByRole("status").textContent).toContain("Implement's last run used opus");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Model for this run" }), { target: { value: "sonnet" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runner.start_run).toHaveBeenCalledWith(id, { stage: "review", model: "sonnet" }));
  });

  it("offers no Run while another run holds the slot, and shows a run under way", async () => {
    const { database, store } = fake_page({ running: true });
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    add_run(database, id, "plan", { state: "running" });
    render(<App />);

    const swimlanes = await card("Swimlanes");
    expect(within(swimlanes).getByText("Running")).toBeTruthy();
    expect(within(swimlanes).queryByRole("button", { name: /^Run / })).toBeNull();
  });

  it("shows a waiting run's question, answering it with a choice", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    const run_id = add_run(database, id, "plan", { state: "waiting", questions: [{ question: "Which board layout?", why: "", choices: ["Lanes", "Columns"] }] });
    render(<App />);

    const swimlanes = await card("Swimlanes");
    expect(within(swimlanes).getByText("Waiting for answers")).toBeTruthy();
    expect(within(swimlanes).getByText("Which board layout?")).toBeTruthy();
    fireEvent.click(within(swimlanes).getByRole("button", { name: "Lanes" }));
    await waitFor(() => expect(runner.answer_run).toHaveBeenCalledWith(run_id, "Lanes"));
  });

  it("shows a failed run's error, opens the item at its run, and discards the last run after a confirm", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
    const run_id = add_run(database, id, "implement", { state: "failed", error: "A gate failed: tests-pass.\nMore." });
    render(<App />);

    const swimlanes = await card("Swimlanes");
    expect(within(swimlanes).getByText("A gate failed: tests-pass.")).toBeTruthy();
    expect(board_card("Swimlanes").classList.contains("tone-edge-bad")).toBe(true);

    fireEvent.click(within(swimlanes).getByRole("button", { name: "More for Swimlanes" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Discard Last Run" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(runner.discard_run).toHaveBeenCalledWith(run_id));
    expect(window.location.hash).toBe("");

    fireEvent.click(within(swimlanes).getByText("Swimlanes"));
    expect(window.location.hash).toBe(`#/items/${id}/${run_id}`);
  });

  it("opens a card with Enter and sends it back a column with Alt and Left after a confirm", async () => {
    const { store } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
    render(<App />);
    await card("Swimlanes");

    fireEvent.keyDown(board_card("Swimlanes"), { key: "ArrowRight", altKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(board_card("Swimlanes"), { key: "ArrowLeft", altKey: true });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/back to Specify\?/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send Back" }));
    await waitFor(() => expect(store.get_item(id).stage).toBe("specify"));

    fireEvent.keyDown(board_card("Swimlanes"), { key: "Enter" });
    expect(window.location.hash).toBe(`#/items/${id}`);
  });

  it("sends a card dragged onto an earlier column back there after a confirm, and offers no later column", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { store } = fake_page();
      const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
      render(<App />);
      await card("Swimlanes");

      fireEvent.dragStart(board_card("Swimlanes"));
      await act(async () => void vi.runOnlyPendingTimers());
      expect(fireEvent.dragOver(cell_under("Review"))).toBe(true);
      expect(fireEvent.dragOver(cell_under("Plan"))).toBe(false);
      fireEvent.drop(cell_under("Plan"));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Send Back" }));
      await waitFor(() => expect(store.get_item(id).stage).toBe("plan"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends an item back to an earlier stage from its menu after a confirm", async () => {
    const { store } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
    render(<App />);

    fireEvent.click(within(await card("Swimlanes")).getByRole("button", { name: "More for Swimlanes" }));
    expect(screen.queryByRole("menuitem", { name: "Send Back to Review" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Send Back to Plan" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Send Back" }));
    await waitFor(() => expect(store.get_item(id).stage).toBe("plan"));
  });

  it("sends a card back only to an earlier column, Done counting as the last", () => {
    const stages = ["triage", "plan", "implement"];
    expect(is_send_back(stages, "implement", "plan")).toBe(true);
    expect(is_send_back(stages, "plan", "implement")).toBe(false);
    expect(is_send_back(stages, "plan", "plan")).toBe(false);
    expect(is_send_back(stages, "done", "triage")).toBe(true);
    expect(is_send_back(stages, "plan", "done")).toBe(false);
    expect(is_send_back(stages, "plan", "gone")).toBe(false);
  });

  it("filters cards by repository and words, shows finished items in Done only when asked, and groups by repository", async () => {
    const { store } = fake_page();
    store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    store.save_item({ title: "Board widget", repository: "x-tech-laboratories/X-Libs", stage: "triage" });
    store.save_item({ title: "Shipped thing", repository: "x-tech-laboratories/X-Dev", stage: "done" });
    render(<App />);

    expect(await card("Swimlanes")).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Shipped thing" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "x-tech-laboratories/X-Libs" } });
    expect(screen.queryByRole("article", { name: "Swimlanes" })).toBeNull();
    expect(screen.getByRole("article", { name: "Board widget" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("switch", { name: "Show finished items" }));
    expect(await card("Shipped thing")).toBeTruthy();
    expect(column_of("Shipped thing")).toBe("Done");
    expect(within(await card("Shipped thing")).queryByRole("list", { name: "Stages" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Group by repository" }));
    const libs_lane = await screen.findByRole("rowheader", { name: /^X-Libs/ });
    expect(within(libs_lane.parentElement!).getByRole("article", { name: "Board widget" })).toBeTruthy();
    expect(within(screen.getByRole("rowheader", { name: /^X-Dev/ }).parentElement!).queryByRole("article", { name: "Board widget" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search items" }), { target: { value: "nothing like it" } });
    expect(await screen.findByText("Nothing matches the filters.")).toBeTruthy();
  });

  it("opens the report of the card's run in a dialog from its menu, clicks in it staying on the board", async () => {
    const { database, store } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
    const run_id = add_run(database, id, "implement", { state: "failed", error: "Out of turns.", cost_usd: 0.5, input_tokens: 1200, output_tokens: 300, report: "## Implement handoff\n**Done:** - Half the lanes" });
    render(<App />);

    fireEvent.click(within(await card("Swimlanes")).getByRole("button", { name: "More for Swimlanes" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open Report" }));
    const dialog = await screen.findByRole("dialog", { name: /Implement Run/ });
    const report = (await within(dialog).findAllByText(/Half the lanes/)).at(-1)!;
    expect(within(dialog).getByRole("alert").textContent).toBe("Out of turns.");
    expect(within(dialog).getByText("1,200 read, 300 written")).toBeTruthy();
    fireEvent.click(report);
    expect(window.location.hash).toBe("");
    expect(within(dialog).getByRole("link", { name: "Open the Item at This Run" }).getAttribute("href")).toBe(`#/items/${id}/${run_id}`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the inbox to its heading while no proposals wait", async () => {
    const { store } = fake_page();
    store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    render(<App />);

    const inbox = (await screen.findByRole("heading", { name: "Inbox 0" })).closest("section")!;
    expect(within(inbox).queryByRole("list")).toBeNull();
  });

  it("shows a failed load with Retry in place of the board", async () => {
    fake_page();
    set_page_api({ ...page(), stages: { list_stages: async () => { throw new Error("stage files unreadable"); } } as unknown as Client<StagesMethods> });
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain("stage files unreadable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows the item's pull request and how its checks stand", async () => {
    const { database, store } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "review" });
    database.prepare("UPDATE items SET pull_request = ? WHERE id = ?").run(JSON.stringify({ number: 9, url: "https://github.com/x-tech-laboratories/X-Dev/pull/9", state: "open", checks: [{ name: "test", bucket: "pass" }, { name: "lint", bucket: "fail" }] }), id);
    render(<App />);

    const swimlanes = await card("Swimlanes");
    expect(within(swimlanes).getByText("PR #9 open")).toBeTruthy();
    expect(within(swimlanes).getByText("1 failed")).toBeTruthy();
  });
});

describe("a card's live run", () => {
  it("watches a running run in a dialog, and interrupts or stops it from the card", async () => {
    const { database, store, runner } = fake_page({ running: true });
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
    const transcript = JSON.stringify({ entries: [{ kind: "text", text: "Writing the lanes." }], activity: "working", model: "claude-opus-5", mode: "auto", dropped: 0 });
    const run_id = add_run(database, id, "implement", { state: "running", transcript, input_tokens: 1200, output_tokens: 300 });
    render(<App />);

    const found = await card("Swimlanes");
    fireEvent.click(within(found).getByRole("button", { name: "Interrupt" }));
    await waitFor(() => expect(runner.interrupt_run).toHaveBeenCalledWith(run_id));
    fireEvent.click(within(found).getByRole("button", { name: "Watch…" }));
    const dialog = await screen.findByRole("dialog", { name: /Implement Transcript/ });
    expect(await within(dialog).findByText("Writing the lanes.")).toBeTruthy();
    expect(within(dialog).getByText("claude-opus-5")).toBeTruthy();
    expect(within(dialog).getByText("1,200 read, 300 written")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(runner.stop_run).toHaveBeenCalledWith(run_id));
  });

  it("retries a failed run from its card, on another model, or from clean", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
    const run_id = add_run(database, id, "implement", { state: "failed", error: "Out of turns.", attempt: 2 });
    render(<App />);

    const found = await card("Swimlanes");
    expect(within(found).getByText("Failed, attempt 2")).toBeTruthy();
    fireEvent.click(within(found).getByRole("button", { name: "Retry Implement on Swimlanes" }));
    await waitFor(() => expect(runner.retry_run).toHaveBeenCalledWith(run_id, {}));

    fireEvent.click(within(found).getByRole("button", { name: "Model…" }));
    const dialog = await screen.findByRole("dialog", { name: /Retry Implement on Another Model/ });
    fireEvent.change(within(dialog).getByLabelText("Model for this run"), { target: { value: "sonnet" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(runner.retry_run).toHaveBeenCalledWith(run_id, { model: "sonnet" }));

    fireEvent.click(within(found).getByRole("button", { name: "More for Swimlanes" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Retry Implement from Clean…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard and Retry" }));
    await waitFor(() => expect(runner.retry_run).toHaveBeenCalledWith(run_id, { clean: true }));
  });

  it("opens a finished run's transcript from the card's menu", async () => {
    const { database, store } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "implement" });
    add_run(database, id, "implement", { state: "done", output: "→ Bash: git status" });
    render(<App />);

    fireEvent.click(within(await card("Swimlanes")).getByRole("button", { name: "More for Swimlanes" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open Transcript" }));
    const dialog = await screen.findByRole("dialog", { name: /Implement Transcript/ });
    expect(await within(dialog).findByText("→ Bash: git status")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

