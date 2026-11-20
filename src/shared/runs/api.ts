// The run calls described for other programs: what each does and the arguments it takes.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import { id_of, text } from "../api_schemas.ts";
import { item_kinds } from "../items/model.ts";
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
    description: "Passes over a gate that failed on a run, with the reason, which is added to the run's report; once every failed gate is passed over, the item moves on to the stage the report names. No agent runs; the next start_run takes that stage.",
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
const on_host = "It acts on the computer that holds the checkouts, with its user's rights.";
const starts_agent = "It starts an AI coding agent on the computer that holds the checkouts, which works in the item's own git worktree with that computer's user's rights and may edit and commit there.";

const new_item = {
  type: "object",
  properties: {
    title: text("What the feature or fix is, in a few words."),
    kind: { type: "string", enum: item_kinds, description: "feature or bug; feature when left out." },
    repository: text("The GitHub repository as owner/name, such as x-tech-laboratories/X-Dev, or the absolute path of its checkout on the computer that runs the agents."),
    body: text("What it asks for, in plain words, as the issue's body."),
    issue_number: { type: ["integer", "null"], minimum: 1, description: "Its GitHub issue's number, when it has one; left out, a matching open issue is linked or a new one opened." },
    stage: text("The stage it starts at; triage unless given."),
    checkout: text("The absolute path of the repository's checkout, when X-Dev does not know it yet; it is added to Repositories."),
  },
  required: ["title", "repository"],
  additionalProperties: false,
  description: "The new item.",
};

// The calls that act on the computer holding the checkouts, served only by a daemon that runs agents and only to an admin.
export const runner_api: ApiSpec<RunnerMethods> = {
  add_item: {
    description:
      "Adds a feature or bug fix to work on, as the New item form's Save does, and is the way to add one: a checkout given is added to Repositories, the item is saved at Triage, and when it has no issue number a matching open GitHub issue is linked or a new one opened through gh. Gives back its id, its repository, the issue, and why the issue could not be reached if it could not; the item is saved either way.",
    params: [{ name: "input", schema: new_item }],
  },
  take_proposal: {
    description: "Takes a proposal from the inbox into the pipeline at Triage and links or opens its GitHub issue, as Take on the board does.",
    params: [{ name: "item_id", schema: id_of("proposal") }],
  },
  describe_item: {
    description: "Turns a rough note, such as a pasted bug report, into a draft item to check and pass to add_item: title, kind, repository and body, and the checkout's folder when it found one. A small, cheap agent reads the note and may search the filesystem read-only; nothing is saved.",
    params: [{ name: "text", schema: text("The description, in any words.") }],
  },
  get_runner: {
    description: "The runner's settings on the computer that runs the agents: each repository's checkout folder, the permission mode, the claude and gh programs and the describing model, and the id of the run under way, if any. The repositories listed here are the ones items can run on.",
    params: [],
  },
  set_runner_setting: {
    description: `Sets the model that fills in described items (describer_model). permission_mode (${permission_modes.join(", ")}), claude_program and gh_program are refused here and change only in X-Dev's own window on that computer.`,
    params: [{ name: "key", schema: { type: "string", enum: ["permission_mode", "claude_program", "describer_model", "gh_program"], description: "The setting's name." } }, { name: "value", schema: text("Its new value.") }],
  },
  set_repository: { description: `Records where a repository's checkout is, so its items can run. ${on_host}`, params: [{ name: "repository", schema: repository }, { name: "folder", schema: folder }] },
  add_repository: { description: `Adds a checkout to Repositories by its folder, reading its owner/name from its origin remote, and gives the name back. Runs then make worktrees inside it. ${on_host}`, params: [{ name: "folder", schema: folder }] },
  remove_repository: { description: "Forgets a repository's checkout; the folder and its worktrees are left alone.", params: [{ name: "repository", schema: repository }] },
  start_run: {
    description: `Starts a stage run on an item and gives back the run's id; follow it with get_run. ${starts_agent} One run goes at a time; the run may stop to ask questions (answer_run) and ends with a report, after which X-Dev's gates check the change.`,
    params: [
      { name: "item_id", schema: id_of("item") },
      {
        name: "options",
        schema: { type: "object", properties: { stage: text("The stage to run, such as plan; the item's own stage unless given."), model: text("A model for this run alone, such as opus; the stage's own unless given.") }, additionalProperties: false, description: "The stage and model; pass {} for the item's stage on its stage's model." },
      },
    ],
  },
  stop_run: { description: "Stops the run under way, or ends a run waiting for answers; its work so far is kept and can be discarded.", params: [{ name: "run_id", schema: id_of("run") }] },
  answer_run: { description: `Answers a run waiting for answers (its questions are in get_run) and resumes the agent's session where it stopped. ${starts_agent}`, params: [{ name: "run_id", schema: id_of("run") }, { name: "answers", schema: text("The answers, in plain words, one per question.") }] },
  discard_run: {
    description: `Drops an item's latest run: its worktree is reset to the commit the run started from, its status sheet and stage go back, and its waiting proposals are dropped. ${on_host}`,
    params: [{ name: "run_id", schema: id_of("run") }],
    destructive: true,
  },
  link_issue: { description: "Links an item with no issue to the open GitHub issue that matches its title, or opens one through gh, and gives back its number.", params: [{ name: "item_id", schema: id_of("item") }] },
  sync_github: { description: "Brings the item's GitHub issue labels, report comments, status sheet and pull request up to date through gh, giving back what failed, or nothing.", params: [{ name: "item_id", schema: id_of("item") }] },
  get_github: { description: "Which GitHub account gh is signed into on the computer that runs the agents.", params: [] },
  sign_in_github: { description: "Starts signing gh in through GitHub's device page and gives back the code to enter there, from any browser.", params: [] },
  sign_out_github: { description: "Signs gh out of GitHub on the computer that runs the agents, for every program that uses it.", params: [], destructive: true },
  get_item_diff: { description: "What the item's branch changed since its work started, file by file with added and removed lines, read from its worktree.", params: [{ name: "item_id", schema: id_of("item") }] },
  list_run_changes: {
    description: "The lines each finished run added and removed, by run id, for the runs whose worktree is on the computer that runs the agents.",
    params: [{ name: "run_ids", schema: { type: "array", items: { type: "string" }, description: "The runs' ids." } }],
  },
};
