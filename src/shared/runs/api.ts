// The run calls described for other programs: what each does and the arguments it takes.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import { id_of, text } from "../api_schemas.ts";
import { permission_modes, type RunnerMethods } from "./runner.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

export const runs_api = {
  list_runs: {
    description: "Lists an item's stage runs, newest first: the stage, its state (running, waiting, done, failed, stopped or discarded), the model, the report, any questions, the tokens and the cost.",
    params: [{ name: "item_id", schema: id_of("item") }],
  },
  get_run: { description: "One run with its input, transcript and report.", params: [{ name: "id", schema: id_of("run") }] },
  list_stage_runs: {
    description: "Lists the latest run of each stage on each item, discarded ones left out, with its state and a one-line summary of its report, as the board shows them.",
    params: [],
  },
  list_run_summaries: {
    description: "Lists every run across every item, newest first, without transcripts: the item's title and repository, the stage, model, state, start and end times, tokens read and written, cost in US dollars, and how many gates ran, failed and were passed over.",
    params: [],
  },
  list_watched_runs: {
    description: "Lists the runs under way and the runs named, each with its item's title, its state, how many proposals it made, the first line of its report, its error and its first question, so a program can tell when one finished, failed or asked.",
    params: [{ name: "run_ids", schema: { type: "array", items: { type: "string" }, description: "The ids of runs seen under way before; empty for only those under way now." } }],
  },
  list_recent_runs: {
    description: "Lists the latest runs across every item, newest first.",
    params: [{ name: "limit", schema: { type: "integer", minimum: 1, description: "How many runs at most." } }],
  },
  update_run_report: {
    description: "Replaces a finished run's report, which the item's next run starts from.",
    params: [{ name: "id", schema: id_of("run") }, { name: "report", schema: text("The whole report block.") }],
  },
  override_gate: {
    description: "Passes over a gate that failed on a run, with the reason, which is added to the run's report; once every failed gate is passed over, the item moves on to the stage the report names.",
    params: [{ name: "run_id", schema: id_of("run") }, { name: "gate", schema: text("The gate's name, such as leftovers.") }, { name: "reason", schema: text("Why it can be passed over.") }],
  },
  send_item_back: {
    description: "Moves an item to another stage, usually an earlier one, so that stage is the one its next run takes; nothing is run and no run is undone.",
    params: [{ name: "item_id", schema: id_of("item") }, { name: "stage", schema: text("The stage's id, such as plan.") }],
  },
  save_item_notes: {
    description: "Sets the notes the item's next run is handed, such as answers, corrections or a change of scope.",
    params: [{ name: "item_id", schema: id_of("item") }, { name: "notes", schema: text("The notes; empty for none.") }],
  },
  list_proposals: { description: "Lists the proposals runs made that wait in the inbox for the user.", params: [] },
  accept_proposal: { description: "Takes a proposal into the pipeline at Triage.", params: [{ name: "id", schema: id_of("proposal") }] },
  drop_proposal: { description: "Drops a proposal; it stays in the history.", params: [{ name: "id", schema: id_of("proposal") }] },
};

// ── Runner ───────────────────────────────────────────────────────────────────

const repository = text("The repository as owner/name, such as x-tech-laboratories/X-Dev.");
const folder = text("An absolute path to a git checkout on the computer that runs the agents.");

// The calls that act on the computer holding the checkouts, served only by a daemon that runs agents and only to an admin.
export const runner_api: ApiSpec<RunnerMethods> = {
  get_runner: {
    description: "The runner's settings on the computer that runs the agents, each repository's checkout folder among them, and the id of the run under way, if any.",
    params: [],
  },
  set_runner_setting: {
    description: `Sets one runner setting: describer_model, the model that fills in described items. permission_mode (${permission_modes.join(", ")}), claude_program and gh_program change only from that computer itself.`,
    params: [{ name: "key", schema: { type: "string", enum: ["permission_mode", "claude_program", "describer_model", "gh_program"], description: "The setting's name." } }, { name: "value", schema: text("Its new value.") }],
  },
  set_repository: { description: "Records where a repository's checkout is.", params: [{ name: "repository", schema: repository }, { name: "folder", schema: folder }] },
  add_repository: { description: "Adds a checkout by its folder, reading its owner/name from its origin remote, and gives the name back.", params: [{ name: "folder", schema: folder }] },
  remove_repository: { description: "Forgets a repository's checkout; the folder itself is left alone.", params: [{ name: "repository", schema: repository }] },
  start_run: {
    description: "Starts a stage run on an item in the background, as a Claude Code session in the item's own worktree, and gives back the run's id. One run goes at a time.",
    params: [
      { name: "item_id", schema: id_of("item") },
      {
        name: "options",
        schema: { type: "object", properties: { stage: text("The stage to run, the item's own unless given."), model: text("A model for this run alone.") }, additionalProperties: false, description: "The stage and model; both may be left out." },
      },
    ],
  },
  stop_run: { description: "Stops the run under way, or a run waiting for answers.", params: [{ name: "run_id", schema: id_of("run") }] },
  answer_run: { description: "Answers a run waiting for answers and resumes its session where it stopped.", params: [{ name: "run_id", schema: id_of("run") }, { name: "answers", schema: text("The answers, in plain words.") }] },
  discard_run: {
    description: "Drops an item's latest run: its worktree, status sheet and stage go back to how they were before it, and its waiting proposals are dropped.",
    params: [{ name: "run_id", schema: id_of("run") }],
    destructive: true,
  },
  describe_item: { description: "Has a small agent turn free text into a draft item to check; nothing is saved.", params: [{ name: "text", schema: text("The description, such as a pasted bug report.") }] },
  link_issue: { description: "Links an item with no issue to the open issue that matches its title, or opens one, and gives back its number.", params: [{ name: "item_id", schema: id_of("item") }] },
  sync_github: { description: "Brings the item's issue labels, report comments, status sheet and pull request up to date, giving back what failed.", params: [{ name: "item_id", schema: id_of("item") }] },
  get_github: { description: "Which GitHub account gh is signed into on the computer that runs the agents.", params: [] },
  sign_in_github: { description: "Starts signing gh in through GitHub's device page and gives back the code to enter there, from any browser.", params: [] },
  sign_out_github: { description: "Signs gh out of GitHub on the computer that runs the agents, for every program that uses it.", params: [], destructive: true },
  get_item_diff: { description: "What the item's branch changed since its work started, file by file, read from its worktree.", params: [{ name: "item_id", schema: id_of("item") }] },
  list_run_changes: {
    description: "The lines each finished run added and removed, by run id, for the runs whose worktree is on the computer that runs the agents.",
    params: [{ name: "run_ids", schema: { type: "array", items: { type: "string" }, description: "The runs' ids." } }],
  },
};
