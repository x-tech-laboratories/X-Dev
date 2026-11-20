// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { create_stage_files } from "../src/server/stage_files.ts";
import { report_summary } from "../src/shared/runs/model.ts";
import { runner_setting_defaults, type RunnerMethods } from "../src/shared/runs/runner.ts";
import { insert_run, update_run } from "../src/shared/runs/store.ts";
import type { StagesMethods } from "../src/shared/stages/model.ts";
import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";
import { drop_move } from "../src/web/board/index.tsx";

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

    const plan = await screen.findByRole("region", { name: "Plan" });
    expect(within(plan).getByRole("article", { name: "Swimlanes" })).toBeTruthy();
    expect(within(plan).getByText("X-Dev #4")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Triage" })).getByRole("article", { name: "Board widget" })).toBeTruthy();
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Triage", "Plan", "Specify", "Implement", "Verify", "Extract", "Docs", "Review", "Release", "Deploy", "Close"]);
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
    expect(within(swimlanes).getByRole("link", { name: "Swimlanes" }).getAttribute("href")).toBe(`#/items/${id}/${run_id}`);

    fireEvent.click(within(swimlanes).getByRole("button", { name: "More for Swimlanes" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Discard Last Run" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(runner.discard_run).toHaveBeenCalledWith(run_id));
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

  it("takes a card dropped on an earlier column back there, and refuses one dropped further on", () => {
    const stages = ["triage", "plan", "implement"];
    expect(drop_move(stages, "implement", "plan")).toBe("back");
    expect(drop_move(stages, "plan", "implement")).toBe("forward");
    expect(drop_move(stages, "plan", "plan")).toBe("none");
    expect(drop_move(stages, "done", "triage")).toBe("back");
    expect(drop_move(stages, "plan", "done")).toBe("forward");
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
    expect(within(await screen.findByRole("region", { name: "Done" })).getByRole("article", { name: "Shipped thing" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Group by repository" }));
    expect(within(await screen.findByRole("region", { name: "Triage, x-tech-laboratories/X-Libs" })).getByRole("article", { name: "Board widget" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "x-tech-laboratories/X-Dev" })).toBeTruthy();
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
