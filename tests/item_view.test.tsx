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
import type { RunnerMethods } from "../src/shared/runs/runner.ts";
import { runner_setting_defaults } from "../src/shared/runs/runner.ts";
import { insert_run, propose, update_run } from "../src/shared/runs/store.ts";
import type { StagesMethods } from "../src/shared/stages/model.ts";
import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";

function as_client(methods: object): unknown {
  return Object.fromEntries(Object.entries(methods as Record<string, (...args: unknown[]) => unknown>).map(([name, call]) => [name, async (...args: unknown[]) => call(...args)]));
}

// The page on a real store and real stage files in throwaway places, with a runner whose calls are recorded.
function fake_page(with_runner = true) {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  stages.add_default_stages();
  const runner = {
    get_runner: vi.fn(() => ({ settings: { ...runner_setting_defaults, repositories: { "x-tech-laboratories/X-Dev": "/checkouts/X-Dev" } }, running_run_id: null })),
    set_runner_setting: vi.fn(),
    set_repository: vi.fn(),
    remove_repository: vi.fn(),
    start_run: vi.fn(async () => "run-1"),
    stop_run: vi.fn(),
    answer_run: vi.fn(),
    discard_run: vi.fn(async () => undefined),
    link_issue: vi.fn(async () => ({ number: 12, opened: true })),
    describe_item: vi.fn(async () => ({ title: "Swimlane board", kind: "feature" as const, repository: "x-tech-laboratories/X-Dev", body: "One lane per item." })),
  } satisfies RunnerMethods;
  set_page_api({
    host: "desktop",
    calls: as_client(store) as unknown as Client<DevMethods>,
    device: null,
    stages: as_client(stages) as unknown as Client<StagesMethods>,
    ...(with_runner ? { runner: as_client(runner) as unknown as Client<RunnerMethods> } : {}),
    on_change: () => () => undefined,
  });
  return { database, store, runner };
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

const item = { title: "Board with swimlanes", repository: "x-tech-laboratories/X-Dev", body: "One lane per item.", stage: "plan" };

function add_run(database: DatabaseSync, item_id: string, changes: Parameters<typeof update_run>[2]) {
  const id = insert_run(database, { item_id, stage: "plan", model: "fable", effort: "high", session_id: "s", start_commit: "", status_before: "{}", input: "", started_at: "2026-11-20T10:00:00.000Z" });
  update_run(database, id, changes);
  return id;
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

afterEach(cleanup);

describe("an item's page", () => {
  it("shows what it asks for and its status sheet, and starts its current stage", async () => {
    const { store, runner } = fake_page();
    const id = store.save_item(item);
    store.update_item_status(id, { goal: "Lanes per item." });
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByRole("heading", { level: 1, name: "Board with swimlanes" })).toBeTruthy();
    expect(screen.getByText("One lane per item.")).toBeTruthy();
    expect(screen.getByText("Lanes per item.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Run Plan" }));

    await waitFor(() => expect(runner.start_run).toHaveBeenCalledWith(id, { stage: "plan" }));
  });

  it("runs another stage on another model when picked, and saves notes for the next run", async () => {
    const { store, runner } = fake_page();
    const id = store.save_item(item);
    render(<App />);
    go(`#/items/${id}`);

    fireEvent.change(await screen.findByRole("combobox", { name: "Stage to run" }), { target: { value: "triage" } });
    fireEvent.change(screen.getByLabelText("Model for this run"), { target: { value: "opus" } });
    fireEvent.click(screen.getByRole("button", { name: "Run Triage" }));
    await waitFor(() => expect(runner.start_run).toHaveBeenCalledWith(id, { stage: "triage", model: "opus" }));

    fireEvent.change(screen.getByLabelText("Notes for the next run"), { target: { value: "Keep it small." } });
    fireEvent.click(screen.getByRole("button", { name: "Save Notes" }));
    await waitFor(() => expect(store.get_item(id).notes).toBe("Keep it small."));
  });

  it("lists each run with its report, and sends answers to a waiting one", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item(item);
    add_run(database, id, { state: "done", report: "## Triage handoff\n**Next:** plan", cost_usd: 0.4 });
    const waiting = add_run(database, id, { state: "waiting", questions: [{ question: "Lanes or columns?", why: "It changes the plan.", choices: ["Lanes", "Columns"] }], started_at: "2026-11-20T11:00:00.000Z" });
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByText("Lanes or columns?")).toBeTruthy();
    expect(screen.getByText("Choices: Lanes · Columns")).toBeTruthy();
    expect(screen.getByText("$0.40")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your answers"), { target: { value: "Lanes." } });
    fireEvent.click(screen.getByRole("button", { name: "Send Answers" }));

    await waitFor(() => expect(runner.answer_run).toHaveBeenCalledWith(waiting, "Lanes."));
  });

  it("finds or opens an issue for an item that has none", async () => {
    const { store, runner } = fake_page();
    const id = store.save_item(item);
    render(<App />);
    go(`#/items/${id}`);

    fireEvent.click(await screen.findByRole("button", { name: "Find or Open an Issue" }));
    await waitFor(() => expect(runner.link_issue).toHaveBeenCalledWith(id));
  });

  it("says runs start from the desktop app where no runner is reached", async () => {
    const { store } = fake_page(false);
    const id = store.save_item(item);
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByText(/Runs start from the desktop app/)).toBeTruthy();
  });
});

describe("the items page", () => {
  it("keeps proposals in the inbox until taken or dropped", async () => {
    const { database, store, runner } = fake_page();
    const source = store.save_item(item);
    const run = add_run(database, source, { state: "done" });
    const taken = propose(database, { item_id: source, run_id: run }, { title: "Faster drawing", why: "It lags." }).item_id;
    propose(database, { item_id: source, run_id: run }, { title: "Export the board", why: "For reports." });
    render(<App />);

    const inbox = (await screen.findByRole("heading", { name: "Inbox (2)" })).closest("section")!;
    fireEvent.click(within(inbox).getByRole("button", { name: "Take Faster drawing" }));
    await waitFor(() => expect(store.get_item(taken).stage).toBe("triage"));
    await waitFor(() => expect(runner.link_issue).toHaveBeenCalledWith(taken));
    fireEvent.click(await screen.findByRole("button", { name: "Drop Export the board" }));
    await waitFor(() => expect(store.list_proposals()).toEqual([]));
  });

  it("adds an item from a description an agent fills in, checked in the form before saving", async () => {
    const { store, runner } = fake_page();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Item" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Describe it"), { target: { value: "Lanes for each feature on the board" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Draft the Item" }));

    await waitFor(() => expect(runner.describe_item).toHaveBeenCalledWith("Lanes for each feature on the board"));
    expect(((await within(dialog).findByLabelText("Title")) as HTMLInputElement).value).toBe("Swimlane board");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(store.list_items()).toHaveLength(1));
    expect(store.list_items()[0]).toMatchObject({ title: "Swimlane board", body: "One lane per item." });
    await waitFor(() => expect(runner.link_issue).toHaveBeenCalledWith(store.list_items()[0]!.id));
  });
});
