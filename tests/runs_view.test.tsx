// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { create_stage_files } from "../src/server/stage_files.ts";
import { insert_run, update_run } from "../src/shared/runs/store.ts";
import type { StagesMethods } from "../src/shared/stages/model.ts";
import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";
import { duration_of } from "../src/web/runs/index.tsx";

function as_client(methods: object): unknown {
  return Object.fromEntries(Object.entries(methods as Record<string, (...args: unknown[]) => unknown>).map(([name, call]) => [name, async (...args: unknown[]) => call(...args)]));
}

function fake_page() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  stages.add_default_stages();
  set_page_api({ host: "desktop", calls: as_client(store) as Client<DevMethods>, device: null, stages: as_client(stages) as Client<StagesMethods>, on_change: () => () => undefined });
  return { database, store };
}

function add_run(database: DatabaseSync, item_id: string, stage: string, model: string, changes: Parameters<typeof update_run>[2], started_at: string) {
  const id = insert_run(database, { item_id, stage, model, effort: "", session_id: "s", start_commit: "", status_before: "{}", input: "", started_at });
  update_run(database, id, changes);
  return id;
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

afterEach(cleanup);

describe("the Runs page", () => {
  it("lists every run with its stage, model, state, tokens, cost and gates, under the totals by stage and model", async () => {
    const { database, store } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev" });
    add_run(database, id, "plan", "fable", { state: "done", cost_usd: 0.5, input_tokens: 1000, output_tokens: 500, ended_at: "2026-11-20T10:02:00.000Z" }, "2026-11-20T10:00:00.000Z");
    add_run(database, id, "implement", "opus", { state: "failed", cost_usd: 2.25, input_tokens: 9000, output_tokens: 1000, gates: [{ gate: "tests-pass", outcome: "failed", findings: [] }], ended_at: "2026-11-20T11:30:00.000Z" }, "2026-11-20T11:00:00.000Z");
    render(<App />);
    go("#/runs");

    const table = await screen.findByRole("table", { name: "Runs" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Implement")).toBeTruthy();
    expect(within(rows[0]!).getByText("opus")).toBeTruthy();
    expect(within(rows[0]!).getByText("$2.25")).toBeTruthy();
    expect(within(rows[0]!).getByText("10,000")).toBeTruthy();
    expect(within(rows[0]!).getByText("1 failed")).toBeTruthy();
    expect(within(rows[1]!).getByText("Plan")).toBeTruthy();
    expect(screen.getAllByText("$2.25 · 1 run").length).toBe(2);
    expect(screen.getAllByText("$0.50 · 1 run").length).toBe(2);

    fireEvent.click(screen.getByRole("radio", { name: "Tokens" }));
    expect(screen.getAllByText("10,000 · 1 run").length).toBe(2);
  });

  it("filters by words and state, and opens a run's item at that run", async () => {
    const { database, store } = fake_page();
    const id = store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev" });
    const other = store.save_item({ title: "Diff view", repository: "x-tech-laboratories/X-Dev" });
    const run_id = add_run(database, id, "plan", "fable", { state: "done" }, "2026-11-20T10:00:00.000Z");
    add_run(database, other, "plan", "fable", { state: "failed" }, "2026-11-20T11:00:00.000Z");
    render(<App />);
    go("#/runs");

    const table = await screen.findByRole("table", { name: "Runs" });
    fireEvent.change(screen.getByRole("combobox", { name: "State" }), { target: { value: "failed" } });
    await waitFor(() => expect(within(table).queryByText("Swimlanes")).toBeNull());
    fireEvent.change(screen.getByRole("combobox", { name: "State" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search runs" }), { target: { value: "swim" } });
    await waitFor(() => expect(within(table).queryByText("Diff view")).toBeNull());

    fireEvent.click(within(table).getByText("Swimlanes"));
    expect(window.location.hash).toBe(`#/items/${id}/${run_id}`);
  });

  it("says when there are no runs, and measures a run under way up to now", async () => {
    fake_page();
    render(<App />);
    go("#/runs");
    expect(await screen.findByText("No runs yet.")).toBeTruthy();
    expect(duration_of({ started_at: "2026-11-20T10:00:00.000Z", ended_at: null }, Date.parse("2026-11-20T10:01:30.000Z"))).toBe(90);
  });
});
