// The runner: starts each stage run as a headless Claude Code session in the item's own git worktree, one run at a time,
// follows its stream into the run's transcript, reads its report, and resumes, stops or discards it on the user's word.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { check_item, is_repository, issue_link, item_kinds, read_status, type Item, type ItemInput, type ItemKind } from "../shared/items/model.ts";
import { answers_input, append_output, branch_name_of, build_run_input, needs_input, parse_report, read_stream_line, type Run, type StreamResult } from "../shared/runs/model.ts";
import { read_runner_settings, type RunnerMethods, type RunnerSettings, type StartOptions } from "../shared/runs/runner.ts";
import { find_run, insert_run, latest_report, runs_in_state, set_item_fields, update_run } from "../shared/runs/store.ts";
import { done, type Stage, type StagesMethods } from "../shared/stages/model.ts";
import { find_or_open_issue } from "./github.ts";
import type { RunMcp } from "./run_mcp.ts";
import { run_token_header } from "./run_mcp.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface RunnerOptions {
  database: () => SqlDatabase;
  stages: StagesMethods;
  run_mcp: RunMcp;
  // Where the runner keeps its settings and each run's agent and MCP files.
  folder: string;
  // Runs after each change to the data, so history records it and the pages hear of it.
  after_write: () => void;
  // The time, for tests.
  now?: () => string;
}

export interface Runner {
  methods: RunnerMethods;
  // Marks runs a stopped daemon left as running as failed; run once at start.
  recover: () => void;
  // Called by the run MCP when an agent asked the user.
  mark_asked: (run_id: string) => void;
  // Settles once the run under way, if any, has ended; for tests and shutting down.
  idle: () => Promise<void>;
  // Stops the run under way, if any, as the daemon stops.
  stop_current: () => void;
}

// How often the transcript is saved while a run streams.
const save_every_ms = 1000;

// ── Git ──────────────────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
  const result = await run_program(["git", ...args], { cwd, stdout: "keep", stderr: "keep" });
  if (result.exit_code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  return result.stdout.trim();
}

async function default_branch(repository_folder: string): Promise<string> {
  try {
    return await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repository_folder);
  } catch {
    return "HEAD";
  }
}

// The item's worktree, made on its own branch from the latest default branch the first time.
async function ensure_worktree(repository_folder: string, branch: string): Promise<string> {
  const worktree = join(repository_folder, ".claude", "worktrees", branch.replace(/^worktree-/, ""));
  if (existsSync(worktree)) return worktree;
  await git(["fetch", "--quiet", "origin"], repository_folder).catch(() => undefined);
  const has_branch = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repository_folder).then(
    () => true,
    () => false,
  );
  if (has_branch) await git(["worktree", "add", worktree, branch], repository_folder);
  else await git(["worktree", "add", "-b", branch, worktree, await default_branch(repository_folder)], repository_folder);
  return worktree;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export function create_runner({ database, stages, run_mcp, folder, after_write, now = () => new Date().toISOString() }: RunnerOptions): Runner {
  const settings_file = join(folder, "runner.json");
  let current: { run_id: string; controller: AbortController; finished: Promise<void> } | null = null;
  const asked = new Set<string>();

  function read_settings(): RunnerSettings {
    return read_runner_settings(existsSync(settings_file) ? JSON.parse(readFileSync(settings_file, "utf8")) : null);
  }

  function write_settings(settings: RunnerSettings): void {
    mkdirSync(folder, { recursive: true });
    writeFileSync(settings_file, JSON.stringify(settings, null, 2));
  }

  function item_of(id: string): Item {
    const row = database().prepare("SELECT * FROM items WHERE id = ?").get(id) as (Omit<Item, "status" | "kind"> & { status: string; kind: ItemKind }) | undefined;
    if (!row) throw new Error(`no item ${id}`);
    return { ...row, status: read_status(row.status) };
  }

  function stage_of(id: string): Stage {
    const stage = stages.list_stages().stages.find((each) => each.id === id);
    if (!stage) throw new Error(`there is no stage ${id}; add it under Settings → Pipeline → Stages`);
    return stage;
  }

  function folder_of(repository: string): string {
    const found = read_settings().repositories[repository];
    if (!found) throw new Error(`X-Dev does not know where ${repository} is on this computer; add it under Settings → Pipeline → Repositories`);
    if (!existsSync(join(found, ".git"))) throw new Error(`${found} is not a git checkout of ${repository}`);
    return found;
  }

  function change(run_id: string, changes: Parameters<typeof update_run>[2]): void {
    update_run(database(), run_id, changes);
    after_write();
  }

  // The agent definition and MCP config a run's session reads, written beside the runner's settings.
  function write_session_files(run: Run, stage: Stage, token: string): { agents: string; mcp: string } {
    const run_folder = join(folder, "runs", run.id);
    mkdirSync(run_folder, { recursive: true, mode: 0o700 });
    const agent = {
      description: stage.description || stage.label,
      prompt: stage.prompt,
      ...(run.model ? { model: run.model } : {}),
      ...(run.effort ? { effort: run.effort } : {}),
      ...(stage.tools.length ? { tools: stage.tools } : {}),
      ...(stage.disallowed_tools.length ? { disallowedTools: stage.disallowed_tools } : {}),
    };
    const agents = join(run_folder, "agents.json");
    const mcp = join(run_folder, "mcp.json");
    writeFileSync(agents, JSON.stringify({ [`stage-${stage.id}`]: agent }, null, 2), { mode: 0o600 });
    writeFileSync(mcp, JSON.stringify({ mcpServers: { "x-dev-run": { type: "http", url: run_mcp.url(), headers: { [run_token_header]: token } } } }, null, 2), { mode: 0o600 });
    return { agents, mcp };
  }

  // What the run does once its session ends: wait for answers, hand its report on, or fail.
  function settle(run_id: string, result: StreamResult | null, exit_text: string, cost: number, aborted: boolean): void {
    const run = find_run(database(), run_id);
    const total = run.cost_usd + cost;
    if (aborted) return change(run_id, { state: "stopped", cost_usd: total, ended_at: now() });
    if (asked.delete(run_id)) return change(run_id, { state: "waiting", cost_usd: total });
    if (!result || result.is_error) return change(run_id, { state: "failed", cost_usd: total, ended_at: now(), error: result?.text || exit_text || "The agent stopped without a result." });
    const report = parse_report(result.text);
    if (!report) return change(run_id, { state: "failed", cost_usd: total, ended_at: now(), error: "The agent ended without a report block naming the next stage." });
    const known = new Set([...stages.list_stages().stages.map((stage) => stage.id), done, needs_input]);
    if (!known.has(report.next)) return change(run_id, { state: "failed", cost_usd: total, ended_at: now(), report: report.text, error: `The report names ${report.next} next, which is no stage.` });
    update_run(database(), run_id, { state: "done", cost_usd: total, ended_at: now(), report: report.text, next: report.next });
    // The notes went to this run; a stage that waits on the user keeps its place.
    set_item_fields(database(), run.item_id, { notes: "", ...(report.next === needs_input ? {} : { stage: report.next }) });
    after_write();
  }

  // Runs one turn of a run's session in the background: a new session, or a resumed one with the user's answers.
  function launch(run: Run, stage: Stage, worktree: string, input: string, resume: boolean): void {
    const settings = read_settings();
    const token = run_mcp.grant({ run_id: run.id, item_id: run.item_id, max_proposals: stage.max_proposals });
    const files = write_session_files(run, stage, token);
    const argv = [
      settings.claude_program,
      "-p",
      "--agents",
      files.agents,
      "--agent",
      `stage-${stage.id}`,
      ...(resume ? ["--resume", run.session_id] : ["--session-id", run.session_id]),
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      settings.permission_mode,
      "--mcp-config",
      files.mcp,
    ];
    const controller = new AbortController();
    let output = run.output;
    let result: StreamResult | null = null;
    let pending = "";
    let last_save = 0;
    const save = (force: boolean) => {
      if (!force && Date.now() - last_save < save_every_ms) return;
      last_save = Date.now();
      change(run.id, { output });
    };
    const sink = {
      write: (chunk: Buffer | string) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const read = read_stream_line(line);
          output = append_output(output, read.lines);
          if (read.result) result = read.result;
        }
        save(false);
      },
    };
    const finished = run_program(argv, { cwd: worktree, stdin: input, stdout: "show", stderr: "keep", out: sink, signal: controller.signal, own_group: true })
      .then(
        (exit) => {
          save(true);
          const exit_text = exit.exit_code === 127 ? `${settings.claude_program} is not installed or not on the PATH` : exit.stderr.trim().split("\n").slice(-5).join("\n");
          settle(run.id, result, exit.exit_code === 0 ? "" : exit_text, (result as StreamResult | null)?.cost_usd ?? 0, controller.signal.aborted);
        },
        (error: unknown) => change(run.id, { state: "failed", ended_at: now(), error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        run_mcp.revoke(token);
        if (current?.run_id === run.id) current = null;
      });
    current = { run_id: run.id, controller, finished };
  }

  function require_free(): void {
    if (current) throw new Error("a run is under way; wait for it or stop it first");
  }

  async function start_run(item_id: string, options: StartOptions): Promise<string> {
    require_free();
    const item = item_of(item_id);
    if (item.closed_at) throw new Error("that item is closed");
    const stage_id = options.stage ?? item.stage;
    if (stage_id === done) throw new Error("that item has been through every stage");
    const stage = stage_of(stage_id);
    const repository_folder = folder_of(item.repository);
    const branch = item.branch || branch_name_of(item);
    const worktree = await ensure_worktree(repository_folder, branch);
    if (!item.branch) set_item_fields(database(), item.id, { branch });
    const start_commit = await git(["rev-parse", "HEAD"], worktree);
    const input = build_run_input({ item: { ...item, branch }, stage_label: stage.label, worktree, issue_url: issue_link(item), latest_report: latest_report(database(), item.id), notes: item.notes });
    require_free();
    const run_id = insert_run(database(), {
      item_id: item.id,
      stage: stage.id,
      model: options.model?.trim() || stage.model,
      effort: stage.effort,
      session_id: crypto.randomUUID(),
      start_commit,
      status_before: JSON.stringify(item.status),
      input,
      started_at: now(),
    });
    // A run sent to another stage moves the item there.
    set_item_fields(database(), item.id, { stage: stage.id });
    after_write();
    launch(find_run(database(), run_id), stage, worktree, input, false);
    return run_id;
  }

  const methods: RunnerMethods = {
    get_runner: () => ({ settings: read_settings(), running_run_id: current?.run_id ?? null }),
    set_runner_setting: (key, value) => {
      write_settings(read_runner_settings({ ...read_settings(), [key]: value }));
    },
    set_repository: (repository, repository_folder) => {
      if (!is_repository(repository)) throw new Error(`"${repository}" is not a repository such as owner/name`);
      if (!existsSync(join(repository_folder, ".git"))) throw new Error(`${repository_folder} is not a git checkout`);
      const settings = read_settings();
      write_settings({ ...settings, repositories: { ...settings.repositories, [repository]: repository_folder } });
    },
    remove_repository: (repository) => {
      const settings = read_settings();
      const { [repository]: _gone, ...rest } = settings.repositories;
      write_settings({ ...settings, repositories: rest });
    },
    start_run,
    stop_run: (run_id) => {
      if (current?.run_id !== run_id) {
        const run = find_run(database(), run_id);
        if (run.state !== "waiting") throw new Error("that run is not under way");
        return change(run_id, { state: "stopped", ended_at: now() });
      }
      current.controller.abort();
    },
    answer_run: (run_id, answers) => {
      require_free();
      const run = find_run(database(), run_id);
      if (run.state !== "waiting") throw new Error("that run is not waiting for answers");
      if (!answers.trim()) throw new Error("write the answers first");
      const item = item_of(run.item_id);
      const worktree = join(folder_of(item.repository), ".claude", "worktrees", item.branch.replace(/^worktree-/, ""));
      change(run_id, { state: "running", answers: `${run.answers}${run.answers ? "\n\n" : ""}${answers.trim()}` });
      launch(find_run(database(), run_id), stage_of(run.stage), worktree, answers_input(run.questions, answers), true);
    },
    discard_run: async (run_id) => {
      const run = find_run(database(), run_id);
      if (run.state === "running") throw new Error("stop the run before discarding it");
      if (run.state === "discarded") return;
      const latest = database().prepare("SELECT id FROM runs WHERE item_id = ? AND state != 'discarded' ORDER BY started_at DESC LIMIT 1").get(run.item_id) as { id: string } | undefined;
      if (latest?.id !== run_id) throw new Error("only the item's latest run can be discarded");
      const item = item_of(run.item_id);
      const worktree = item.branch ? join(folder_of(item.repository), ".claude", "worktrees", item.branch.replace(/^worktree-/, "")) : "";
      if (worktree && run.start_commit && existsSync(worktree)) {
        await git(["reset", "--hard", run.start_commit], worktree);
        await git(["clean", "-fd"], worktree);
      }
      // Proposals the run made that still wait in the inbox go with it.
      database().prepare("UPDATE items SET closed_at = ? WHERE source_run_id = ? AND stage = 'proposed' AND closed_at IS NULL").run(now(), run_id);
      set_item_fields(database(), run.item_id, { status: run.status_before, stage: run.stage });
      update_run(database(), run_id, { state: "discarded", ended_at: run.ended_at ?? now() });
      rmSync(join(folder, "runs", run_id), { recursive: true, force: true });
      after_write();
    },
    describe_item: async (text) => {
      const description = text.trim();
      if (!description) throw new Error("describe the feature or bug first");
      const settings = read_settings();
      const tracked = (database().prepare("SELECT DISTINCT repository FROM items").all() as { repository: string }[]).map((row) => row.repository);
      const repositories = [...new Set([...Object.keys(settings.repositories), ...tracked])].sort();
      const prompt = [
        "Turn the description below into one JSON object and reply with that object alone:",
        `{"title": "what it is in a few words", "kind": "${item_kinds.join('" or "')}", "repository": "owner/name: one of ${JSON.stringify(repositories)} when it fits, else the one the description names, else empty", "body": "what it asks for, in plain words, as an issue's body"}`,
        "",
        description,
      ].join("\n");
      const result = await run_program([settings.claude_program, "-p", "--model", settings.describer_model, "--output-format", "json", "--tools", ""], { stdin: prompt, stdout: "keep", stderr: "keep", cwd: folder });
      if (result.exit_code !== 0) throw new Error(`the agent could not describe it: ${result.stderr.trim().split("\n").at(-1) || `exit ${result.exit_code}`}`);
      return draft_of_reply(JSON.parse(result.stdout) as { result?: string }, repositories);
    },
    link_issue: async (item_id) => {
      const item = item_of(item_id);
      if (item.issue_number !== null) return { number: item.issue_number, opened: false };
      const link = await find_or_open_issue({ repository: item.repository, title: item.title, body: item.body }, read_settings().gh_program);
      set_item_fields(database(), item_id, { issue_number: link.number });
      after_write();
      return link;
    },
  };

  return {
    methods,
    recover: () => {
      for (const run of runs_in_state(database(), "running")) update_run(database(), run.id, { state: "failed", ended_at: now(), error: "X-Dev stopped while the run was under way." });
      after_write();
    },
    mark_asked: (run_id) => void asked.add(run_id),
    idle: async () => {
      while (current) await current.finished;
    },
    stop_current: () => current?.controller.abort(),
  };
}

// ── Describing ───────────────────────────────────────────────────────────────

// The known repository a guess names, matched without case and by its name alone, or the guess itself when it is a
// repository name at all; empty otherwise.
export function match_repository(guess: string, repositories: string[]): string {
  const wanted = guess.trim().toLowerCase();
  if (!wanted) return "";
  const exact = repositories.find((repository) => repository.toLowerCase() === wanted);
  if (exact) return exact;
  const by_name = repositories.filter((repository) => repository.split("/")[1]!.toLowerCase() === wanted.split("/").at(-1));
  if (by_name.length === 1) return by_name[0]!;
  return is_repository(guess.trim()) ? guess.trim() : "";
}

// The draft an agent's reply gives, its fields checked loosely so the user can fix what is off before saving.
export function draft_of_reply(reply: { result?: string }, repositories: string[]): ItemInput {
  const text = String(reply.result ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the agent did not give a draft; fill the form in by hand");
  const fields = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const repository = match_repository(String(fields.repository ?? ""), repositories);
  const draft: ItemInput = {
    title: String(fields.title ?? "").trim(),
    kind: item_kinds.includes(fields.kind as ItemKind) ? (fields.kind as ItemKind) : "feature",
    repository,
    body: String(fields.body ?? "").trim(),
  };
  // Checked only for its shape; an empty repository is left for the user to pick.
  if (draft.repository) check_item(draft);
  return draft;
}
