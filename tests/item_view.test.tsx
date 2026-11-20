// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { create_item_calls } from "../src/server/item_calls.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import type { ChangeScope, ChangeSet, RunnerMethods } from "../src/shared/runs/runner.ts";
import { runner_setting_defaults } from "../src/shared/runs/runner.ts";
import { insert_run, propose, update_run } from "../src/shared/runs/store.ts";
import type { StagesMethods } from "../src/shared/stages/model.ts";
import { parse_unified_diff } from "../src/shared/diff/parse.ts";
import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { page, set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";

function as_client(methods: object): unknown {
  return Object.fromEntries(Object.entries(methods as Record<string, (...args: unknown[]) => unknown>).map(([name, call]) => [name, async (...args: unknown[]) => call(...args)]));
}

const changed_file = { path: "src/board.ts", old_path: "src/board.ts", status: "changed" as const, additions: 1, deletions: 1, binary: false, fingerprint: "f1" };

const sample_diff = ["diff --git a/src/board.ts b/src/board.ts", "index 1111111..2222222 100644", "--- a/src/board.ts", "+++ b/src/board.ts", "@@ -1,2 +1,2 @@", " keep", "-old line", "+new line", ""].join("\n");

// The page on a real store and real stage files in throwaway places, with a runner whose calls are recorded.
function fake_page(with_runner = true) {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  stages.add_default_stages();
  const recorded = {
    get_runner: vi.fn(() => ({ settings: { ...runner_setting_defaults, repositories: { "x-tech-laboratories/X-Dev": "/checkouts/X-Dev" } }, running_run_id: null })),
    set_runner_setting: vi.fn(),
    set_repository: vi.fn(),
    add_repository: vi.fn(async () => "x-tech-laboratories/X-Libs"),
    remove_repository: vi.fn(),
    start_run: vi.fn(async () => "run-1"),
    stop_run: vi.fn(),
    interject_run: vi.fn(),
    interrupt_run: vi.fn(async () => undefined),
    retry_run: vi.fn(async () => "run-2"),
    set_run_mode: vi.fn(async () => undefined),
    answer_permission: vi.fn(),
    answer_run: vi.fn(),
    discard_run: vi.fn(async () => undefined),
    link_issue: vi.fn(async () => ({ number: 12, opened: true })),
    sync_github: vi.fn(async () => ""),
    get_github: vi.fn(async () => ({ signed_in: true, account: "someone", problem: "" })),
    sign_in_github: vi.fn(async () => ({ code: "ABCD-1234", url: "https://github.com/login/device" })),
    sign_out_github: vi.fn(async () => undefined),
    describe_item: vi.fn(async () => ({ title: "Swimlane board", kind: "feature" as const, repository: "x-tech-laboratories/X-Dev", body: "One lane per item." })),
    get_changes: vi.fn(async (_item_id: string, _scope: ChangeScope, _run_id: string): Promise<ChangeSet> => ({ base: "abc123", run_id: "", files: [changed_file], problem: "" })),
    get_file_change: vi.fn(async () => ({ file: parse_unified_diff(sample_diff)[0]!, truncated: false })),
    revert_file: vi.fn(async () => undefined),
    list_files: vi.fn(async () => ({ paths: ["README.md", "docs/guide.md", "logo.png", "src/board.ts"], truncated: true })),
    get_file: vi.fn(async (_item_id: string, path: string) => (path === "logo.png" ? { path, size: 9, symlink: false, text: null, reason: "binary" as const } : { path, size: 20, symlink: false, text: "# Guide\nRead me.\n", reason: "" as const })),
    list_run_changes: vi.fn(async () => ({})),
    get_run_update: vi.fn(),
  };
  // Adding and taking run the daemon's own code over the recorded calls, as they do on the daemon.
  const runner = { ...recorded, ...create_item_calls({ database: () => database, after_write: () => undefined, runner: recorded }) } satisfies RunnerMethods;
  set_page_api({
    host: "desktop",
    daemon_is_here: with_runner,
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

  it("shows each gate's result and passes a failed one over with a reason, moving the item on", async () => {
    const { database, store } = fake_page();
    const id = store.save_item(item);
    const run = add_run(database, id, {
      state: "failed",
      report: "## Plan handoff\n**Next:** specify",
      next: "specify",
      gates: [
        { gate: "report", outcome: "passed", findings: [] },
        { gate: "status", outcome: "failed", findings: ["the run did not update the status sheet"] },
      ],
    });
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByText("the run did not update the status sheet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pass Over…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Why it can be passed over"), { target: { value: "Nothing new to note." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(store.get_run(run).state).toBe("done"));
    expect(store.get_item(id).stage).toBe("specify");
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

    const inbox = (await screen.findByRole("heading", { name: "Inbox 2" })).closest("section")!;
    fireEvent.click(within(inbox).getByRole("button", { name: "Take Faster drawing" }));
    await waitFor(() => expect(store.get_item(taken).stage).toBe("triage"));
    await waitFor(() => expect(runner.link_issue).toHaveBeenCalledWith(taken));
    fireEvent.click(await screen.findByRole("button", { name: "Drop Export the board" }));
    await waitFor(() => expect(store.list_proposals()).toEqual([]));
  });

  it("adds the checkout the describing agent found when the repository is new to X-Dev", async () => {
    const { store, runner } = fake_page();
    runner.describe_item.mockResolvedValueOnce({ title: "Wrap the board", kind: "feature", repository: "x-tech-laboratories/X-Libs", body: "", checkout: "/checkouts/X-Libs" } as never);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Item" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Describe it"), { target: { value: "A board widget in X-Libs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Draft the Item" }));

    expect(((await within(dialog).findByLabelText("Checkout")) as HTMLInputElement).value).toBe("/checkouts/X-Libs");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(runner.add_repository).toHaveBeenCalledWith("/checkouts/X-Libs"));
    await waitFor(() => expect(store.list_items().map((each) => each.repository)).toEqual(["x-tech-laboratories/X-Libs"]));
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

describe("an item's changes and runs", () => {
  it("shows the changed files as a tree and the picked file's diff side by side, or in one column", async () => {
    const { store, runner } = fake_page();
    const id = store.save_item(item);
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByText(/1 file changed/)).toBeTruthy();
    expect(runner.get_changes).toHaveBeenCalledWith(id, "item", "");
    expect(screen.getByRole("tree", { name: "Changed files" })).toBeTruthy();
    const split = await screen.findByRole("table", { name: /src\/board.ts, old on the left/ });
    expect(within(split).getByText("old").closest("td")!.className).toContain("tone-fill-bad");
    expect(within(split).getByText("new").className).toContain("tone-fill-good");

    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    const unified = await screen.findByRole("table", { name: "Changes to src/board.ts" });
    expect(within(unified).getByText("new").closest("tr")!.className).toBe("tone-fill-good");
  });

  it("shows every file with the changed ones marked, and an unchanged file's text read-only", async () => {
    const { store, runner } = fake_page();
    const id = store.save_item(item);
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByRole("tree", { name: "Changed files" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "All files" }));
    const tree = await screen.findByRole("tree", { name: "All files" });
    expect(runner.list_files).toHaveBeenCalledWith(id);
    expect(within(tree).getByTitle("Modified")).toBeTruthy();
    expect(within(tree).queryByText("guide.md")).toBeNull();
    expect(screen.getByText(/only the first 4 files are listed/)).toBeTruthy();

    fireEvent.click(within(tree).getByText("docs/"));
    fireEvent.click(within(tree).getByText("guide.md"));
    const contents = await screen.findByRole("table", { name: "Contents of docs/guide.md" });
    expect(within(contents).getByText("Read me.")).toBeTruthy();
    expect(screen.getByText("Unchanged")).toBeTruthy();
    expect(runner.get_file).toHaveBeenCalledWith(id, "docs/guide.md");

    fireEvent.click(within(tree).getByText("logo.png"));
    expect(await screen.findByText(/A binary file/)).toBeTruthy();
  });

  it("says why there are no changes to show", async () => {
    const { store, runner } = fake_page();
    runner.get_changes.mockResolvedValue({ base: "", run_id: "", files: [], problem: "The item has no worktree yet; its first run makes one." });
    const id = store.save_item(item);
    render(<App />);
    go(`#/items/${id}`);
    expect(await screen.findByText(/no worktree yet/)).toBeTruthy();
  });

  it("switches to the whole item's changes, ticks a file reviewed and reverts one after a confirm", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item(item);
    const run = add_run(database, id, { state: "done" });
    runner.get_changes.mockImplementation(async (_item_id, scope) => ({ base: "abc123", run_id: run, files: scope === "run" ? [changed_file] : [changed_file, { ...changed_file, path: "docs/notes.md", old_path: "docs/notes.md", status: "added" as const }], problem: "" }));
    render(<App />);
    go(`#/items/${id}`);

    const changes = (await screen.findByRole("heading", { name: "Changes" })).closest("section")!;
    expect(await within(changes).findByText(/0 of 1 reviewed/)).toBeTruthy();
    expect(runner.get_changes).toHaveBeenCalledWith(id, "run", "");
    fireEvent.click(within(changes).getByRole("checkbox", { name: "Reviewed" }));
    await waitFor(() => expect(store.get_run(run).reviewed).toEqual({ "src/board.ts": "f1" }));
    expect(await within(changes).findByText(/1 of 1 reviewed/)).toBeTruthy();

    fireEvent.click(within(changes).getByRole("radio", { name: "Whole item" }));
    expect(await within(changes).findByText(/2 files changed/)).toBeTruthy();
    fireEvent.click(within(changes).getByText("notes.md"));
    fireEvent.click(within(changes).getByRole("button", { name: "Revert File…" }));
    const dialog = await screen.findByRole("dialog", { name: /Revert docs\/notes.md/ });
    expect(within(dialog).getByText(/The file is removed/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revert File" }));
    await waitFor(() => expect(runner.revert_file).toHaveBeenCalledWith(id, "item", run, "docs/notes.md"));
  });

  it("warns when Review would run on the model Implement's last run used", async () => {
    const { database, store } = fake_page();
    const id = store.save_item({ ...item, stage: "review" });
    add_run(database, id, { stage: "implement", state: "done" });
    render(<App />);
    go(`#/items/${id}`);

    fireEvent.change(await screen.findByLabelText("Model for this run"), { target: { value: "fable" } });
    expect(await screen.findByText(/Implement's last run used fable/)).toBeTruthy();
  });

  it("opens at the run the address names, its report shown, with its tokens", async () => {
    const { database, store } = fake_page();
    const id = store.save_item(item);
    const first = add_run(database, id, { state: "done", report: "## Plan handoff\n**Next:** specify\n**Done:** - The first plan", input_tokens: 1200, output_tokens: 300 });
    add_run(database, id, { state: "done", report: "## Plan handoff\n**Next:** specify\n**Done:** - The second plan", started_at: "2026-11-20T11:00:00.000Z" });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<App />);
    go(`#/items/${id}/${first}`);

    expect(await screen.findByText(/The first plan/)).toBeTruthy();
    expect(screen.getByText("1,200 read, 300 written")).toBeTruthy();
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
  });
});

// A transcript part-way through a run: the stage input, thinking still streaming, an edit, a command that failed and a message not read yet.
const live_transcript = JSON.stringify({
  model: "claude-opus-5",
  mode: "auto",
  activity: "working",
  dropped: 0,
  entries: [
    { kind: "user", role: "input", id: "u0", text: "You are running the Plan stage." },
    { kind: "text", text: "Reading the **board** code.", streaming: false },
    { kind: "tool", id: "t1", name: "Edit", input: { file_path: "src/board.ts", old_string: "old lane", new_string: "new lane" }, result: "Edited.", streaming: false },
    { kind: "tool", id: "t2", name: "Bash", input: { command: "npm test" }, result: "1 failed", is_error: true, streaming: false },
    { kind: "thinking", text: "The lanes need a key.", streaming: true },
    { kind: "tool", id: "t3", name: "Grep", input: { pattern: "lane_key" }, streaming: false },
    { kind: "user", role: "interjection", id: "u1", text: "Keep lanes narrow.", pending: true },
  ],
});

describe("a run as it happens", () => {
  it("shows the transcript's steps, and stops, interrupts and steers the run", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item(item);
    const run = add_run(database, id, { state: "running", transcript: live_transcript });
    render(<App />);
    go(`#/items/${id}`);

    const log = await screen.findByRole("log", { name: "Transcript" });
    expect(within(log).getByText("board").tagName).toBe("STRONG");
    expect(within(log).getByText("Thinking…")).toBeTruthy();
    expect(within(log).getByText("src/board.ts", { selector: "code.transcript-line" })).toBeTruthy();
    expect(within(log).getByText("new lane").closest("tr")!.className).toBe("tone-fill-good");
    expect(within(log).getByText("failed")).toBeTruthy();
    expect(within(log).getByText("Not read yet")).toBeTruthy();
    expect(within(log).getByRole("status", { name: "Running" }).previousElementSibling!.textContent).toBe("Grep");
    expect(within(log).getByText("What Plan was given")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    await waitFor(() => expect(runner.interrupt_run).toHaveBeenCalledWith(run));
    fireEvent.change(screen.getByLabelText("Message to the agent"), { target: { value: "Use one lane per repository." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(runner.interject_run).toHaveBeenCalledWith(run, "Use one lane per repository."));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(runner.stop_run).toHaveBeenCalledWith(run));
  });

  it("offers a way back to the newest step once the reader scrolls up", async () => {
    const { database, store } = fake_page();
    const id = store.save_item(item);
    add_run(database, id, { state: "running", transcript: live_transcript });
    render(<App />);
    go(`#/items/${id}`);

    const log = await screen.findByRole("log", { name: "Transcript" });
    Object.defineProperties(log, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 300, configurable: true } });
    log.scrollTop = 0;
    fireEvent.scroll(log);
    fireEvent.click(await screen.findByRole("button", { name: "Jump to Latest" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Jump to Latest" })).toBeNull());
  });

  it("shows a halted run waiting for a message, and an old run's plain output", async () => {
    const { database, store } = fake_page();
    const id = store.save_item(item);
    add_run(database, id, { state: "running", transcript: JSON.stringify({ entries: [], activity: "paused", model: "", mode: "", dropped: 3 }) });
    add_run(database, id, { state: "done", output: "→ Bash: git status", started_at: "2026-11-20T09:00:00.000Z" });
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByText("Halted, waiting for your message")).toBeTruthy();
    expect(screen.getByText(/3 earlier steps were left out/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Interrupt" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("→ Bash: git status")).toBeTruthy();
  });
});

describe("retrying a stage", () => {
  it("retries a failed run, on another model when picked, or from clean after a confirm", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item(item);
    const run = add_run(database, id, { state: "failed", error: "Out of turns." });
    render(<App />);
    go(`#/items/${id}`);

    fireEvent.change(await screen.findByLabelText("Model for this run"), { target: { value: "opus" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry Plan" }));
    await waitFor(() => expect(runner.retry_run).toHaveBeenCalledWith(run, { model: "opus" }));

    fireEvent.click(screen.getByRole("button", { name: "Retry from Clean…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard and Retry" }));
    await waitFor(() => expect(runner.retry_run).toHaveBeenCalledWith(run, { clean: true, model: "opus" }));
  });

  it("retries from the run's own panel and its menu", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item(item);
    const run = add_run(database, id, { state: "stopped", attempt: 2 });
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByText(/Attempt 2 of Plan/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(runner.retry_run).toHaveBeenCalledWith(run, {}));
    fireEvent.click(screen.getByRole("button", { name: "More ways to retry Plan" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Retry on Another Model…" }));
    const dialog = await screen.findByRole("dialog", { name: /Retry Plan on Another Model/ });
    fireEvent.change(within(dialog).getByLabelText("Model for this run"), { target: { value: "haiku" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(runner.retry_run).toHaveBeenCalledWith(run, { model: "haiku" }));
  });

  it("is not offered while a run waits only on its pull request's checks", async () => {
    const { database, store } = fake_page();
    const id = store.save_item(item);
    add_run(database, id, { state: "failed", gates: [{ gate: "ci", outcome: "failed", findings: ["still running: test; X-Dev checks again when they finish"] }] });
    render(<App />);
    go(`#/items/${id}`);

    expect(await screen.findByRole("button", { name: "Run Plan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("a run's permissions", () => {
  const asking = (mode: string) =>
    JSON.stringify({
      model: "claude-opus-5",
      mode,
      activity: "working",
      dropped: 0,
      entries: [
        { kind: "permission", id: "p1", tool: "Bash", input: { command: "npm install left-pad" }, reason: "It installs a package." },
        { kind: "permission", id: "p0", tool: "Write", input: { file_path: "a.ts", content: "x" }, reason: "", decision: "denied", message: "Not there." },
      ],
    });

  it("shows a tool call waiting for approval, and allows, allows for the run or denies it with a reason", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item(item);
    const run = add_run(database, id, { state: "running", transcript: asking("default"), awaiting: "Bash" });
    render(<App />);
    go(`#/items/${id}`);

    const request = await screen.findByRole("group", { name: "Bash waits for approval" });
    expect(within(request).getByText("It installs a package.")).toBeTruthy();
    expect(within(request).getAllByText("npm install left-pad")).toHaveLength(1);
    expect(screen.getByText("Waiting for approval: Bash")).toBeTruthy();
    expect(screen.getByText("Reason given: Not there.")).toBeTruthy();
    fireEvent.click(within(request).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(runner.answer_permission).toHaveBeenCalledWith(run, "p1", "allowed", ""));
    fireEvent.click(within(request).getByRole("button", { name: "Allow npm commands for This Run" }));
    await waitFor(() => expect(runner.answer_permission).toHaveBeenCalledWith(run, "p1", "allowed_for_run", ""));
    fireEvent.change(within(request).getByLabelText("Why Bash is refused"), { target: { value: "No new packages." } });
    fireEvent.click(within(request).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(runner.answer_permission).toHaveBeenCalledWith(run, "p1", "denied", "No new packages."));
  });

  it("switches the mode of a running run, and starts a run in a mode picked for it", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item(item);
    const run = add_run(database, id, { state: "running", transcript: asking("manual") });
    render(<App />);
    go(`#/items/${id}`);

    const mode = await screen.findByRole("combobox", { name: "Permission mode" });
    expect((mode as HTMLSelectElement).value).toBe("default");
    fireEvent.change(mode, { target: { value: "auto" } });
    await waitFor(() => expect(runner.set_run_mode).toHaveBeenCalledWith(run, "auto"));

    update_run(database, run, { state: "done" });
    cleanup();
    render(<App />);
    go(`#/items/${id}`);
    fireEvent.change(await screen.findByRole("combobox", { name: "Permission mode for this run" }), { target: { value: "acceptEdits" } });
    fireEvent.click(screen.getByRole("button", { name: "Run Plan" }));
    await waitFor(() => expect(runner.start_run).toHaveBeenCalledWith(id, { stage: "plan", mode: "acceptEdits" }));
  });
});

describe("a run's permissions from another device", () => {
  it("offers only Manual and allows a tool call once, never for the whole run", async () => {
    const { database, store, runner } = fake_page();
    set_page_api({ ...page(), daemon_is_here: false });
    const id = store.save_item(item);
    add_run(database, id, { state: "running", transcript: JSON.stringify({ model: "", mode: "auto", activity: "working", dropped: 0, entries: [{ kind: "permission", id: "p1", tool: "Bash", input: { command: "ls" }, reason: "" }] }) });
    render(<App />);
    go(`#/items/${id}`);

    const request = await screen.findByRole("group", { name: "Bash waits for approval" });
    expect(within(request).queryByRole("button", { name: /for This Run/ })).toBeNull();
    const mode = screen.getByRole("combobox", { name: "Permission mode" }) as HTMLSelectElement;
    expect([...mode.options].map((option) => option.textContent)).toEqual(["Auto", "Manual"]);
    const pick = screen.getByRole("combobox", { name: "Permission mode for this run" }) as HTMLSelectElement;
    expect([...pick.options].map((option) => option.textContent)).toEqual(["As the runner's setting says", "Manual"]);
    expect(runner.set_run_mode).not.toHaveBeenCalled();
  });
});

