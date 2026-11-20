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
  const id = insert_run(database, { item_id, stage, model: "", effort: "", session_id: "s", start_commit: "", status_before: "{}", input: "", started_at });
  update_run(database, id, changes);
  return id;
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
  it("is the page X-Dev opens on, with a column per stage and a lane per item, grouped by repository", async () => {
    const { store } = fake_page();
    store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan", issue_number: 4 });
    store.save_item({ title: "Board widget", repository: "x-tech-laboratories/X-Libs", stage: "triage" });
    render(<App />);

    const board = await screen.findByRole("table", { name: "Board" });
    expect(within(board).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Item", "Triage", "Plan", "Specify", "Implement", "Verify", "Extract", "Docs", "Review", "Release", "Deploy", "Close"]);
    expect(within(board).getByText("x-tech-laboratories/X-Dev")).toBeTruthy();
    expect(within(board).getByRole("link", { name: "#4" }).getAttribute("href")).toBe("https://github.com/x-tech-laboratories/X-Dev/issues/4");
  });

  it("shows each stage's latest run with its summary, earlier stages without one as skipped, and Run at the current stage", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    add_run(database, id, "triage", { state: "done", report: "## Triage handoff\n**Next:** plan\n**Done:** - Sorted as a feature" });
    render(<App />);

    const triage = await screen.findByRole("cell", { name: "Swimlanes, Triage" });
    expect(within(triage).getByText("Sorted as a feature")).toBeTruthy();
    expect(within(triage).getByText("Done")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("cell", { name: "Swimlanes, Plan" })).getByRole("button", { name: "Run Plan on Swimlanes" }));
    await waitFor(() => expect(runner.start_run).toHaveBeenCalledWith(id, {}));
  });

  it("offers no Run while another run holds the slot, and shows a run under way", async () => {
    const { database, store } = fake_page({ running: true });
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    add_run(database, id, "plan", { state: "running" });
    render(<App />);

    const plan = await screen.findByRole("cell", { name: "Swimlanes, Plan" });
    expect(within(plan).getByText("Running")).toBeTruthy();
    expect(within(plan).queryByRole("button")).toBeNull();
  });

  it("filters lanes by repository and words, and keeps finished items folded away unless asked", async () => {
    const { store } = fake_page();
    store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    store.save_item({ title: "Board widget", repository: "x-tech-laboratories/X-Libs", stage: "triage" });
    store.save_item({ title: "Shipped thing", repository: "x-tech-laboratories/X-Dev", stage: "done" });
    render(<App />);

    expect(await screen.findByRole("link", { name: "Swimlanes" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Shipped thing" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "x-tech-laboratories/X-Libs" } });
    expect(screen.queryByRole("link", { name: "Swimlanes" })).toBeNull();
    expect(screen.getByRole("link", { name: "Board widget" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("switch", { name: "Show finished items" }));
    expect(await screen.findByRole("link", { name: "Shipped thing" })).toBeTruthy();
  });
});
