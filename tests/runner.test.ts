import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { create_github_sync, type GitHubSync } from "../src/server/github_sync.ts";
import { create_run_tools, type RunTools } from "../src/server/run_tools.ts";
import { checkout_names, checkout_of_reply, create_runner, draft_of_reply, find_checkout, match_repository, search_roots, type Runner } from "../src/server/runner.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import { live_run_api } from "../src/shared/runs/live_api.ts";
import { runner_method_names } from "../src/shared/runs/runner.ts";
import { read_transcript } from "../src/shared/runs/transcript.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

const fake_claude = join(import.meta.dirname, "fixtures", "fake_claude.mjs");
const fake_gh = join(import.meta.dirname, "fixtures", "fake_gh.mjs");
const repository = "x-tech-laboratories/X-Dev";

// A throwaway git checkout with one commit, standing in for the repository's own.
function make_checkout(): string {
  const folder = mkdtempSync(join(tmpdir(), "x-dev-checkout-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(folder, "README.md"), "# Test\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-q", "-m", "chore: start");
  return folder;
}

let run_tools: RunTools | null = null;
let runner: Runner | null = null;

afterEach(async () => {
  runner?.stop_current();
  await runner?.idle();
  await run_tools?.stop();
});

async function setup(github?: (database: DatabaseSync) => GitHubSync) {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  stages.add_default_stages();
  run_tools = create_run_tools({ database: () => database, after_write: () => undefined, on_asked: (run_id) => runner!.mark_asked(run_id) });
  await run_tools.start();
  runner = create_runner({ database: () => database, stages, run_tools, folder: mkdtempSync(join(tmpdir(), "x-dev-runner-")), after_write: () => undefined, ...(github ? { github: github(database) } : {}) });
  const checkout = make_checkout();
  runner.methods.set_runner_setting("claude_program", fake_claude);
  runner.methods.set_repository(repository, checkout);
  const item = (body: string) => store.save_item({ title: "Board with swimlanes", repository, body, stage: "plan", issue_number: 7 });
  return { store, runner, checkout, item };
}

describe("the runner", () => {
  it("runs a stage in the item's own worktree and moves the item to the stage its report names", async () => {
    const { store, runner, checkout, item } = await setup();
    const id = item("Plan it. STATUS");
    store.save_item_notes(id, "Keep it small.");

    const run_id = await runner.methods.start_run(id, {});
    expect(runner.methods.get_runner().running_run_id).toBe(run_id);
    await runner.idle();

    const run = store.get_run(run_id);
    expect(run).toMatchObject({ state: "done", stage: "plan", model: "fable", effort: "high", next: "specify", cost_usd: 0.25, input_tokens: 120, output_tokens: 30 });
    expect(run.report.startsWith("## Plan handoff")).toBe(true);
    expect(run.output).toContain("→ Bash: git status");
    expect(run.input).toContain("Keep it small.");
    expect(run.input).toContain("worktree-item-7");
    expect(store.get_item(id)).toMatchObject({ stage: "specify", branch: "worktree-item-7", notes: "" });
    expect(existsSync(join(checkout, ".claude", "worktrees", "item-7"))).toBe(true);
  });

  it("hands the next run the latest report, and runs a model given for one run", async () => {
    const { store, runner, item } = await setup();
    const id = item("Plan it. STATUS");
    await runner.methods.start_run(id, {});
    await runner.idle();

    const second = await runner.methods.start_run(id, { model: "haiku" });
    await runner.idle();

    expect(store.get_run(second)).toMatchObject({ stage: "specify", model: "haiku" });
    expect(store.get_run(second).input).toContain("## Plan handoff");
  });

  it("refuses a second run while one is under way, and stops it on the user's word", async () => {
    const { store, runner, item } = await setup();
    const id = item("SLOW");
    const run_id = await runner.methods.start_run(id, {});

    await expect(runner.methods.start_run(item("Another."), {})).rejects.toThrow("a run is under way");
    runner.methods.stop_run(run_id);
    await runner.idle();

    expect(store.get_run(run_id).state).toBe("stopped");
    expect(runner.methods.get_runner().running_run_id).toBeNull();
  });

  it("fails a run whose agent gave no report, saying so", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("NO-REPORT"), {});
    await runner.idle();

    expect(store.get_run(run_id)).toMatchObject({ state: "failed", error: "The agent ended without a report block naming the next stage." });
  });

  it("waits for answers when the agent asks, then resumes the same session with them", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("ASK STATUS"), {});
    await runner.idle();

    const waiting = store.get_run(run_id);
    expect(waiting.state).toBe("waiting");
    expect(waiting.questions).toEqual([{ question: "Which board layout?", why: "It changes the plan.", choices: ["Lanes", "Columns"] }]);

    runner.methods.answer_run(run_id, "Lanes.");
    await runner.idle();
    expect(store.get_run(run_id)).toMatchObject({ state: "done", next: "implement", answers: "Lanes.", cost_usd: 0.5, input_tokens: 240, output_tokens: 60 });
  });

  it("lets the agent update the status sheet and propose items, up to its stage's limit", async () => {
    const { store, runner, item } = await setup();
    const id = item("STATUS PROPOSE");
    const run_id = await runner.methods.start_run(id, {});
    await runner.idle();

    expect(store.get_item(id).status.current_state).toBe("Planned by the fake agent.");
    expect(store.list_proposals().map((proposal) => proposal.title).sort()).toEqual(["A third proposal here", "Another idea entirely", "Faster board drawing"]);
    expect(store.get_run(run_id).output).toContain("this run has made its 3 proposals");
  });

  it("discards the latest run, putting back the worktree, the status sheet, the stage and its proposals", async () => {
    const { store, runner, checkout, item } = await setup();
    const id = item("WRITE-FILE STATUS PROPOSE");
    const run_id = await runner.methods.start_run(id, {});
    await runner.idle();
    expect(existsSync(join(checkout, ".claude", "worktrees", "item-7", "made-by-run.txt"))).toBe(true);

    await runner.methods.discard_run(run_id);

    expect(existsSync(join(checkout, ".claude", "worktrees", "item-7", "made-by-run.txt"))).toBe(false);
    expect(store.get_item(id)).toMatchObject({ stage: "plan", status: { current_state: "" } });
    expect(store.list_proposals()).toEqual([]);
    expect(store.get_run(run_id).state).toBe("discarded");
  });

  it("holds the item when a gate fails, until the gate is passed over with a reason", async () => {
    const { store, runner, item } = await setup();
    const id = item("Plan it, leaving the status sheet as it was.");
    const run_id = await runner.methods.start_run(id, {});
    await runner.idle();

    const run = store.get_run(run_id);
    expect(run).toMatchObject({ state: "failed", next: "specify", error: "A gate failed: status. Run the stage again, or pass a gate over with a reason." });
    expect(run.gates).toEqual([
      { gate: "report", outcome: "passed", findings: [] },
      { gate: "status", outcome: "failed", findings: ["the run did not update the status sheet"] },
    ]);
    expect(store.get_item(id).stage).toBe("plan");

    expect(() => store.override_gate(run_id, "report", "fine")).toThrow("the report gate did not fail on that run");
    store.override_gate(run_id, "status", "Nothing changed worth noting.");
    expect(store.get_run(run_id)).toMatchObject({ state: "done", overrides: [{ gate: "status", reason: "Nothing changed worth noting." }] });
    expect(store.get_run(run_id).report).toContain("**Gate passed over:** status: Nothing changed worth noting.");
    expect(store.get_item(id).stage).toBe("specify");
  });

  it("fails a stage that changed files outside what it may touch", async () => {
    const { store, runner, item } = await setup();
    const id = item("WRITE-FILE STATUS");
    const run_id = await runner.methods.start_run(id, { stage: "specify" });
    await runner.idle();

    const scope = store.get_run(run_id).gates.find((gate) => gate.gate === "scope")!;
    expect(scope).toEqual({ gate: "scope", outcome: "failed", findings: ["made-by-run.txt is outside what this stage may change (tests/**)"] });
  });

  it("adds a checkout by its folder, reading owner/name from its origin, and refuses one without", async () => {
    const { runner, checkout } = await setup();
    execFileSync("git", ["remote", "add", "origin", "git@github.com:x-tech-laboratories/X-Libs.git"], { cwd: checkout });

    expect(await runner.methods.add_repository(checkout)).toBe("x-tech-laboratories/X-Libs");
    expect(runner.methods.get_runner().settings.repositories["x-tech-laboratories/X-Libs"]).toBe(checkout);
    await expect(runner.methods.add_repository(make_checkout())).rejects.toThrow("has no origin remote naming its repository");
    await expect(runner.methods.add_repository(tmpdir())).rejects.toThrow("is not a git checkout");
  });

  it("says where to add a repository it does not know", async () => {
    const { store, runner } = await setup();
    const id = store.save_item({ title: "Elsewhere", repository: "x-tech-laboratories/X-Libs", stage: "plan" });

    await expect(runner.methods.start_run(id, {})).rejects.toThrow("add its checkout on the Repositories page");
  });

  it("marks runs a stopped daemon left running as failed", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("SLOW"), {});
    runner.recover();

    expect(store.get_run(run_id)).toMatchObject({ state: "failed", error: "X-Dev stopped while the run was under way." });
  });
});

// Waits until the run's saved transcript shows the check passing.
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!check()) throw new Error("it never happened");
}

describe("a live run", () => {
  it("keeps a transcript of thinking, text, tool calls with their results and the stage input", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("Plan it. STATUS"), {});
    await runner.idle();

    const transcript = read_transcript(store.get_run(run_id).transcript);
    expect(transcript).toMatchObject({ model: "claude-fake-1", activity: "ended", dropped: 0 });
    expect(transcript.entries.map((entry) => entry.kind)).toEqual(["user", "thinking", "text", "tool", "text"]);
    expect(transcript.entries[0]).toMatchObject({ kind: "user", role: "input", pending: false });
    expect(transcript.entries[1]).toMatchObject({ kind: "thinking", text: "I should look at the item first.", streaming: false });
    expect(transcript.entries[3]).toMatchObject({ kind: "tool", name: "Bash", input: { command: "git status" }, result: "nothing to commit", is_error: false });
    expect(transcript.entries[4]).toMatchObject({ kind: "text", text: expect.stringContaining("## Plan handoff") });
  });

  it("writes the user's message into the session, which reads it after its step, and notes it in Decisions", async () => {
    const { store, runner, item } = await setup();
    const id = item("LISTEN STATUS");
    const run_id = await runner.methods.start_run(id, {});
    await until(() => read_transcript(store.get_run(run_id).transcript).entries.some((entry) => entry.kind === "tool" && entry.input.command === "sleep 30"));

    expect(() => runner.methods.interject_run(run_id, "  ")).toThrow("write the message first");
    runner.methods.interject_run(run_id, "Keep the lanes narrow.");
    await runner.idle();

    const run = store.get_run(run_id);
    const entries = read_transcript(run.transcript).entries;
    expect(entries.find((entry) => entry.kind === "user" && entry.role === "interjection")).toMatchObject({ text: "Keep the lanes narrow.", pending: false });
    expect(entries.some((entry) => entry.kind === "text" && entry.text === "Heard: Keep the lanes narrow.")).toBe(true);
    expect(run).toMatchObject({ state: "done", interjections: [{ text: "Keep the lanes narrow." }] });
    expect(store.get_item(id).status.decisions).toBe("- The user told Plan while it ran: Keep the lanes narrow.");
    expect(() => runner.methods.interject_run(run_id, "Too late.")).toThrow("that run is not under way");
  });

  it("halts the current step on an interrupt and goes on with the user's next message", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("SLOW STATUS"), {});
    await until(() => read_transcript(store.get_run(run_id).transcript).entries.some((entry) => entry.kind === "tool" && entry.input.command === "sleep 30"));

    await runner.methods.interrupt_run(run_id);
    await until(() => read_transcript(store.get_run(run_id).transcript).activity === "paused");
    expect(store.get_run(run_id).state).toBe("running");
    expect(runner.methods.get_runner().running_run_id).toBe(run_id);

    runner.methods.interject_run(run_id, "Skip the slow part.");
    await runner.idle();
    const run = store.get_run(run_id);
    const entries = read_transcript(run.transcript).entries;
    expect(entries.some((entry) => entry.kind === "notice" && entry.text.startsWith("Interrupted"))).toBe(true);
    expect(entries.some((entry) => entry.kind === "text" && entry.text === "Going on after: Skip the slow part.")).toBe(true);
    expect(run).toMatchObject({ state: "done", cost_usd: 0.5, input_tokens: 240 });
  });

  it("describes each call on a live run for other programs", () => {
    for (const [name, spec] of Object.entries(live_run_api)) {
      expect(runner_method_names).toContain(name);
      expect(spec.description.length).toBeGreaterThan(40);
      expect(spec.params[0]!.name).toBe("run_id");
    }
  });

  it("refuses to interrupt a run that is not under way", async () => {
    const { runner } = await setup();
    expect(() => runner.methods.interrupt_run("nothing")).toThrow("that run is not under way");
  });
});

describe("a run's permission mode", () => {
  const waiting_on = (store: ReturnType<typeof bind_methods>, run_id: string) => read_transcript(store.get_run(run_id).transcript).entries.filter((entry) => entry.kind === "permission" && !entry.decision);

  it("starts in the mode picked for it, with tool calls asked of X-Dev over the stream", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("Plan it. STATUS"), { mode: "acceptEdits" });
    await runner.idle();

    expect(store.get_run(run_id).permission_mode).toBe("acceptEdits");
    expect(read_transcript(store.get_run(run_id).transcript).mode).toBe("acceptEdits");
  });

  it("holds a tool call for the user, and lets the same kind through for the rest of the run once allowed for it", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("PERMIT TWICE STATUS"), { mode: "default" });
    await until(() => waiting_on(store, run_id).length === 1);

    expect(store.get_run(run_id).awaiting).toBe("Bash");
    expect(store.list_stage_runs()[0]!.awaiting).toBe("Bash");
    const request = waiting_on(store, run_id)[0]!;
    expect(request).toMatchObject({ tool: "Bash", input: { command: "rm -rf build" }, reason: "It changes files outside the worktree." });
    runner.methods.answer_permission(run_id, request.kind === "permission" ? request.id : "", "allowed_for_run", "");
    await runner.idle();

    const run = store.get_run(run_id);
    expect(run).toMatchObject({ state: "done", awaiting: "", allowed: ["Bash(rm)"] });
    const entries = read_transcript(run.transcript).entries;
    expect(entries.filter((entry) => entry.kind === "permission").map((entry) => entry.kind === "permission" && entry.decision)).toEqual(["allowed_for_run"]);
    expect(entries.filter((entry) => entry.kind === "tool" && entry.result === "removed")).toHaveLength(2);
  });

  it("sends a refusal's reason back to the agent", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("PERMIT STATUS"), { mode: "default" });
    await until(() => waiting_on(store, run_id).length === 1);
    const request = waiting_on(store, run_id)[0]!;

    expect(() => runner.methods.answer_permission(run_id, "nothing", "allowed", "")).toThrow("that request is no longer waiting");
    runner.methods.answer_permission(run_id, request.kind === "permission" ? request.id : "", "denied", "Never delete the build folder.");
    await runner.idle();

    const entries = read_transcript(store.get_run(run_id).transcript).entries;
    expect(entries.find((entry) => entry.kind === "permission")).toMatchObject({ decision: "denied", message: "Never delete the build folder." });
    expect(entries.find((entry) => entry.kind === "tool" && entry.input.command === "rm -rf build")).toMatchObject({ result: "Never delete the build folder.", is_error: true });
  });

  it("switches the mode of the session under way", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("SLOW STATUS"), {});
    await until(() => read_transcript(store.get_run(run_id).transcript).entries.some((entry) => entry.kind === "tool" && entry.input.command === "sleep 30"));

    await expect(runner.methods.set_run_mode(run_id, "plan" as never)).rejects.toThrow("is not a permission mode");
    await runner.methods.set_run_mode(run_id, "acceptEdits");
    expect(store.get_run(run_id).permission_mode).toBe("acceptEdits");
    await runner.methods.interrupt_run(run_id);
    await until(() => read_transcript(store.get_run(run_id).transcript).activity === "paused");
    runner.methods.interject_run(run_id, "MODE");
    await runner.idle();

    expect(read_transcript(store.get_run(run_id).transcript).entries.some((entry) => entry.kind === "text" && entry.text === "Mode is acceptEdits.")).toBe(true);
  });
});

describe("a run's changes", () => {
  it("lists and shows what a run changed, and reverts a file, noting it in the run and the status sheet", async () => {
    const { store, runner, checkout, item } = await setup();
    const id = item("WRITE-FILE STATUS");
    const run_id = await runner.methods.start_run(id, {});
    await runner.idle();

    const changes = await runner.methods.get_changes(id, "run", run_id);
    expect(changes.files.map((file) => [file.path, file.status])).toEqual([["made-by-run.txt", "added"]]);
    expect((await runner.methods.get_file_change(id, "run", run_id, "made-by-run.txt")).file?.additions).toBe(1);
    store.set_file_reviewed(run_id, "made-by-run.txt", changes.files[0]!.fingerprint);

    await runner.methods.revert_file(id, "run", run_id, "made-by-run.txt");
    expect(existsSync(join(checkout, ".claude", "worktrees", "item-7", "made-by-run.txt"))).toBe(false);
    expect(store.get_run(run_id)).toMatchObject({ reviewed: {}, reverts: [{ path: "made-by-run.txt", scope: "run", base: store.get_run(run_id).start_commit }] });
    expect(store.get_item(id).status.decisions).toBe("- The user reverted made-by-run.txt to how it was before the Plan run; do not bring the change back.");
  });

  it("refuses to revert while a run on the item is under way", async () => {
    const { store, runner, item } = await setup();
    const id = item("SLOW");
    const run_id = await runner.methods.start_run(id, {});
    await until(() => store.get_run(run_id).transcript !== "");

    await expect(runner.methods.revert_file(id, "run", run_id, "README.md")).rejects.toThrow("a run on this item is under way");
  });
});

describe("retrying a stage", () => {
  it("runs the stage again on the worktree as it was, telling the agent how the last attempt ended", async () => {
    const { store, runner, checkout, item } = await setup();
    const id = item("WRITE-FILE Plan it, leaving the status sheet as it was.");
    const failed = await runner.methods.start_run(id, {});
    await runner.idle();
    expect(store.get_run(failed).state).toBe("failed");

    store.save_item({ id, title: "Board with swimlanes", repository, body: "Plan it. STATUS", stage: "plan", issue_number: 7 });
    const retry = await runner.methods.retry_run(failed, { model: "haiku" });
    await runner.idle();

    const run = store.get_run(retry);
    expect(run).toMatchObject({ stage: "plan", model: "haiku", retry_of: failed, attempt: 2, state: "done" });
    expect(run.input).toContain("## Previous attempt");
    expect(run.input).toContain("- status: the run did not update the status sheet");
    expect(run.input).toContain("Its report:\n\n## Plan handoff");
    expect(store.get_run(failed).state).toBe("failed");
    expect(existsSync(join(checkout, ".claude", "worktrees", "item-7", "made-by-run.txt"))).toBe(true);
    await expect(runner.methods.retry_run(retry, {})).rejects.toThrow("only a failed or stopped run can be retried");
  });

  it("from clean discards the failed run first and starts without the last attempt's story", async () => {
    const { store, runner, checkout, item } = await setup();
    const id = item("WRITE-FILE NO-REPORT");
    const failed = await runner.methods.start_run(id, {});
    await runner.idle();
    store.save_item({ id, title: "Board with swimlanes", repository, body: "Plan it. STATUS", stage: "plan", issue_number: 7 });

    const retry = await runner.methods.retry_run(failed, { clean: true });
    await runner.idle();

    expect(store.get_run(failed).state).toBe("discarded");
    expect(store.get_run(retry)).toMatchObject({ retry_of: failed, attempt: 2 });
    expect(store.get_run(retry).input).not.toContain("## Previous attempt");
    expect(existsSync(join(checkout, ".claude", "worktrees", "item-7", "made-by-run.txt"))).toBe(false);
  });

  it("retries only the stage's latest run", async () => {
    const { runner, item } = await setup();
    const id = item("NO-REPORT");
    const first = await runner.methods.start_run(id, {});
    await runner.idle();
    await runner.methods.start_run(id, {});
    await runner.idle();

    await expect(runner.methods.retry_run(first, {})).rejects.toThrow("only the stage's latest run can be retried");
  });
});

describe("a described item's repository", () => {
  it("is a known one matched without case or owner, else the agent's guess when it is a repository name", () => {
    const known = ["x-tech-laboratories/X-Dev", "x-tech-laboratories/X-Libs", "beatlink/x-libs"];
    expect(match_repository("X-TECH-LABORATORIES/x-dev", known)).toBe("x-tech-laboratories/X-Dev");
    expect(match_repository("X-Dev", known)).toBe("x-tech-laboratories/X-Dev");
    expect(match_repository("x-libs", known)).toBe("");
    expect(match_repository("someone/new-repo", known)).toBe("someone/new-repo");
    expect(match_repository("", known)).toBe("");
  });
});

describe("linking an item's issue", () => {
  it("records the issue found or opened, and leaves an item that has one alone", async () => {
    const { store, runner } = await setup();
    runner.methods.set_runner_setting("gh_program", fake_gh);
    const id = store.save_item({ title: "Swimlanes on the board", repository: "owner/has-match" });
    const numbered = store.save_item({ title: "Numbered", repository, issue_number: 9 });

    expect(await runner.methods.link_issue(id)).toEqual({ number: 5, opened: false });
    expect(store.get_item(id).issue_number).toBe(5);
    expect(await runner.methods.link_issue(numbered)).toEqual({ number: 9, opened: false });
  });
});

describe("mirroring runs to GitHub", () => {
  afterEach(() => {
    delete process.env.FAKE_GH_DATA;
  });

  // A fake GitHub holding the item's issue #7, and the runner's sync reaching it through the fake gh.
  async function setup_with_github() {
    const file = join(mkdtempSync(join(tmpdir(), "x-dev-github-")), "github.json");
    writeFileSync(file, JSON.stringify({ issues: { "7": { state: "OPEN", labels: [], body: "", comments: [] } }, labels: [], pulls: [], checks: {}, next_comment_id: 100, calls: [] }));
    process.env.FAKE_GH_DATA = file;
    let sync: GitHubSync | null = null;
    const context = await setup((database) => (sync = create_github_sync({ database: () => database, program: () => fake_gh, after_write: () => undefined })));
    const issue = () => (JSON.parse(readFileSync(file, "utf8")) as { issues: Record<string, { labels: string[]; comments: { body: string }[] }> }).issues["7"]!;
    return { ...context, sync: sync!, issue };
  }

  it("posts the report and moves the stage label once a run ends, and marks the comment of a discarded run", async () => {
    const { store, runner, item, sync, issue } = await setup_with_github();
    const id = item("Plan it. STATUS");
    const run_id = await runner.methods.start_run(id, {});
    await runner.idle();
    await sync.sync_item(id);

    expect(issue().comments).toEqual([{ id: 100, body: expect.stringContaining("## Plan handoff") }]);
    expect(issue().labels).toEqual(["stage:specify"]);

    await runner.methods.discard_run(run_id);
    await sync.sync_item(id);
    expect(issue().comments[0]!.body).toContain("run was discarded");
    expect(issue().labels).toEqual(["stage:plan"]);
    expect(await runner.methods.sync_github(id)).toBe("");
    expect(store.get_item_github(id).mirror.problem).toBe("");
  });

  it("is refused where the runner has no GitHub sync", async () => {
    const { runner, item } = await setup();
    await expect(runner.methods.sync_github(item("Plan it."))).rejects.toThrow("does not reach GitHub");
  });
});

describe("finding a repository's checkout", () => {
  it("looks a few levels under the roots for a checkout whose origin names it", async () => {
    const projects = mkdtempSync(join(tmpdir(), "x-dev-projects-"));
    mkdirSync(join(projects, "Org"));
    const libs = make_checkout();
    const target = join(projects, "Org", "X-Libs");
    execFileSync("git", ["clone", "-q", libs, target]);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/x-tech-laboratories/X-Libs.git"], { cwd: target });

    expect(await checkout_names(target, "X-TECH-LABORATORIES/x-libs")).toBe(true);
    expect(await checkout_names(target, "x-tech-laboratories/X-Dev")).toBe(false);
    expect(await find_checkout("x-tech-laboratories/X-Libs", [projects])).toBe(target);
    expect(await find_checkout("x-tech-laboratories/X-Nix", [projects])).toBeNull();
  });

  it("starts beside the known checkouts, else at home, and reads the path an agent gave", () => {
    expect(search_roots(["/p/Org/X-Dev", "/p/Org/X-Libs", "/q/Other"])).toEqual(["/p/Org", "/q"]);
    expect(search_roots([])).toHaveLength(1);
    expect(checkout_of_reply({ result: '{"title": "x", "checkout": " /p/Org/X-Libs "}' })).toBe("/p/Org/X-Libs");
    expect(checkout_of_reply({ result: "no json" })).toBe("");
  });
});

describe("a described item's draft", () => {
  it("takes the agent's JSON, fenced or not", () => {
    const reply = { result: '```json\n{"title": "Swimlanes", "kind": "bug", "repository": "x-tech-laboratories/X-Dev", "body": "Lanes per item."}\n```' };
    expect(draft_of_reply(reply, [repository])).toEqual({ title: "Swimlanes", kind: "bug", repository, body: "Lanes per item." });
    expect(draft_of_reply({ result: '{"title": "Swimlanes", "kind": "chore", "repository": "x-dev"}' }, [repository])).toEqual({ title: "Swimlanes", kind: "feature", repository, body: "" });
    expect(() => draft_of_reply({ result: "No idea." }, [])).toThrow("fill the form in by hand");
  });
});
