import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { create_run_mcp, type RunMcp } from "../src/server/run_mcp.ts";
import { create_runner, draft_of_reply, match_repository, type Runner } from "../src/server/runner.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
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

let run_mcp: RunMcp | null = null;
let runner: Runner | null = null;

afterEach(async () => {
  runner?.stop_current();
  await runner?.idle();
  await run_mcp?.stop();
});

async function setup() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  stages.add_default_stages();
  run_mcp = create_run_mcp({ database: () => database, after_write: () => undefined, on_asked: (run_id) => runner!.mark_asked(run_id) });
  await run_mcp.start();
  runner = create_runner({ database: () => database, stages, run_mcp, folder: mkdtempSync(join(tmpdir(), "x-dev-runner-")), after_write: () => undefined });
  const checkout = make_checkout();
  runner.methods.set_runner_setting("claude_program", fake_claude);
  runner.methods.set_repository(repository, checkout);
  const item = (body: string) => store.save_item({ title: "Board with swimlanes", repository, body, stage: "plan", issue_number: 7 });
  return { store, runner, checkout, item };
}

describe("the runner", () => {
  it("runs a stage in the item's own worktree and moves the item to the stage its report names", async () => {
    const { store, runner, checkout, item } = await setup();
    const id = item("Plan it.");
    store.save_item_notes(id, "Keep it small.");

    const run_id = await runner.methods.start_run(id, {});
    expect(runner.methods.get_runner().running_run_id).toBe(run_id);
    await runner.idle();

    const run = store.get_run(run_id);
    expect(run).toMatchObject({ state: "done", stage: "plan", model: "fable", effort: "high", next: "specify", cost_usd: 0.25 });
    expect(run.report.startsWith("## Plan handoff")).toBe(true);
    expect(run.output).toContain("→ Bash: git status");
    expect(run.input).toContain("Keep it small.");
    expect(run.input).toContain("worktree-item-7");
    expect(store.get_item(id)).toMatchObject({ stage: "specify", branch: "worktree-item-7", notes: "" });
    expect(existsSync(join(checkout, ".claude", "worktrees", "item-7"))).toBe(true);
  });

  it("hands the next run the latest report, and runs a model given for one run", async () => {
    const { store, runner, item } = await setup();
    const id = item("Plan it.");
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
    const run_id = await runner.methods.start_run(item("ASK"), {});
    await runner.idle();

    const waiting = store.get_run(run_id);
    expect(waiting.state).toBe("waiting");
    expect(waiting.questions).toEqual([{ question: "Which board layout?", why: "It changes the plan.", choices: ["Lanes", "Columns"] }]);

    runner.methods.answer_run(run_id, "Lanes.");
    await runner.idle();
    expect(store.get_run(run_id)).toMatchObject({ state: "done", next: "implement", answers: "Lanes.", cost_usd: 0.5 });
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

  it("says where to add a repository it does not know", async () => {
    const { store, runner } = await setup();
    const id = store.save_item({ title: "Elsewhere", repository: "x-tech-laboratories/X-Libs", stage: "plan" });

    await expect(runner.methods.start_run(id, {})).rejects.toThrow("add it under Settings → Pipeline → Repositories");
  });

  it("marks runs a stopped daemon left running as failed", async () => {
    const { store, runner, item } = await setup();
    const run_id = await runner.methods.start_run(item("SLOW"), {});
    runner.recover();

    expect(store.get_run(run_id)).toMatchObject({ state: "failed", error: "X-Dev stopped while the run was under way." });
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

describe("a described item's draft", () => {
  it("takes the agent's JSON, fenced or not", () => {
    const reply = { result: '```json\n{"title": "Swimlanes", "kind": "bug", "repository": "x-tech-laboratories/X-Dev", "body": "Lanes per item."}\n```' };
    expect(draft_of_reply(reply, [repository])).toEqual({ title: "Swimlanes", kind: "bug", repository, body: "Lanes per item." });
    expect(draft_of_reply({ result: '{"title": "Swimlanes", "kind": "chore", "repository": "x-dev"}' }, [repository])).toEqual({ title: "Swimlanes", kind: "feature", repository, body: "" });
    expect(() => draft_of_reply({ result: "No idea." }, [])).toThrow("fill the form in by hand");
  });
});
