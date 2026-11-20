// What the page asks of whichever host runs the agents, and that host's own settings, which belong to its computer.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DiffFile, DiffFileStatus } from "../diff/parse.ts";
import type { ItemInput } from "../items/model.ts";
import type { RunMode } from "./modes.ts";
import type { PermissionDecision } from "./transcript.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export const permission_modes = ["auto", "acceptEdits", "dontAsk", "bypassPermissions"] as const;

export type PermissionMode = (typeof permission_modes)[number];

export interface RunnerSettings {
  // Each repository as owner/name and the folder its checkout is in on this computer.
  repositories: Record<string, string>;
  // How the agent's actions are approved with no one watching; auto checks each one.
  permission_mode: PermissionMode;
  // The claude program, found on the PATH unless given.
  claude_program: string;
  // The model that turns a description into an item.
  describer_model: string;
  // The gh program, signed into GitHub, through which issues are found and opened.
  gh_program: string;
}

export const runner_setting_defaults: RunnerSettings = { repositories: {}, permission_mode: "auto", claude_program: "claude", describer_model: "haiku", gh_program: "gh" };

// Settings saved on the computer, each default where it is missing or damaged.
export function read_runner_settings(saved: unknown): RunnerSettings {
  const fields = (saved ?? {}) as Partial<Record<keyof RunnerSettings, unknown>>;
  const repositories = fields.repositories && typeof fields.repositories === "object" ? (fields.repositories as Record<string, unknown>) : {};
  return {
    repositories: Object.fromEntries(Object.entries(repositories).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    permission_mode: permission_modes.includes(fields.permission_mode as PermissionMode) ? (fields.permission_mode as PermissionMode) : runner_setting_defaults.permission_mode,
    claude_program: typeof fields.claude_program === "string" && fields.claude_program.trim() ? fields.claude_program.trim() : runner_setting_defaults.claude_program,
    describer_model: typeof fields.describer_model === "string" && fields.describer_model.trim() ? fields.describer_model.trim() : runner_setting_defaults.describer_model,
    gh_program: typeof fields.gh_program === "string" && fields.gh_program.trim() ? fields.gh_program.trim() : runner_setting_defaults.gh_program,
  };
}

// ── Calls ────────────────────────────────────────────────────────────────────

export interface StartOptions {
  // The stage to run, the item's own unless given, such as to send it back.
  stage?: string;
  // A model for this run alone.
  model?: string;
  // A permission mode for this run alone, instead of the stage's.
  mode?: RunMode;
}

export interface RetryOptions {
  // A model for the retry alone.
  model?: string;
  // A permission mode for the retry alone.
  mode?: RunMode;
  // Discards the failed run first, so the retry starts from where that run started and is not told how it ended.
  clean?: boolean;
}

export interface RunnerStatus {
  settings: RunnerSettings;
  // The run under way, which holds the one run slot.
  running_run_id: string | null;
}

export interface RunnerMethods {
  get_runner: () => RunnerStatus;
  set_runner_setting: <Key extends keyof Omit<RunnerSettings, "repositories">>(key: Key, value: RunnerSettings[Key]) => void;
  set_repository: (repository: string, folder: string) => void;
  // Adds a checkout by its folder, reading its owner/name from its origin remote, and gives the name back.
  add_repository: (folder: string) => Promise<string>;
  remove_repository: (repository: string) => void;
  // Starts a stage run in the background and gives back its id.
  start_run: (item_id: string, options: StartOptions) => Promise<string>;
  stop_run: (run_id: string) => void;
  // Writes a message from the user into the run under way, which its agent reads after its current step.
  interject_run: (run_id: string, text: string) => void;
  // Halts the run's current step at once, leaving its session open for the user's next message.
  interrupt_run: (run_id: string) => Promise<void>;
  // Runs a failed or stopped run's stage again and gives back the new run's id.
  retry_run: (run_id: string, options: RetryOptions) => Promise<string>;
  // Switches the permission mode of the run under way from its next tool call on.
  set_run_mode: (run_id: string, mode: RunMode) => Promise<void>;
  // Allows or refuses a tool call the run under way waits on, with the reason given back to the agent for a refusal.
  answer_permission: (run_id: string, request_id: string, decision: PermissionDecision, message: string) => void;
  answer_run: (run_id: string, answers: string) => void;
  discard_run: (run_id: string) => Promise<void>;
  // Saves a new item as the New item form does: its checkout added when given, its issue found or opened when it has none.
  add_item: (input: NewItem) => Promise<AddedItem>;
  // Takes a proposal into Triage and finds or opens its issue.
  take_proposal: (item_id: string) => Promise<AddedItem>;
  // A draft item from free text, filled in by an agent for the user to check; nothing is saved.
  describe_item: (text: string) => Promise<ItemDraft>;
  // Links an item with no issue to an open one that matches it, or opens one.
  link_issue: (item_id: string) => Promise<IssueLink>;
  // Brings the item's issue labels, report comments, status sheet and pull request up to date, giving back what failed.
  sync_github: (item_id: string) => Promise<string>;
  get_github: () => Promise<GitHubAccount>;
  // Starts signing gh into GitHub in the browser and gives back the code to enter there.
  sign_in_github: () => Promise<GitHubSignIn>;
  sign_out_github: () => Promise<void>;
  // The files changed since the run started, or since the item's work started, read from the item's worktree.
  get_changes: (item_id: string, scope: ChangeScope, run_id: string) => Promise<ChangeSet>;
  // One changed file's diff with every unchanged line kept.
  get_file_change: (item_id: string, scope: ChangeScope, run_id: string, path: string) => Promise<FileChange>;
  // Puts one file back as it was when the scope started, noting it in the run and the status sheet.
  revert_file: (item_id: string, scope: ChangeScope, run_id: string, path: string) => Promise<void>;
  // The lines each finished run added and removed, by run id, for the runs whose worktree is on this computer.
  list_run_changes: (run_ids: string[]) => Promise<Record<string, LineCounts>>;
}

// Whether changes count from the run's start or the item's.
export type ChangeScope = "run" | "item";

export interface ChangedFile {
  path: string;
  // The path before a rename; the same as path otherwise.
  old_path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  // Names the file's content now, so a reviewed mark clears once it changes.
  fingerprint: string;
}

export interface ChangeSet {
  // The commit the changes count from; empty when there is nothing to read.
  base: string;
  // The run the scope belongs to: the one asked for, else the item's latest.
  run_id: string;
  files: ChangedFile[];
  // Why there is nothing to show, such as no worktree yet; empty otherwise.
  problem: string;
}

export interface FileChange {
  // Null when git shows no lines for it, such as a binary file.
  file: DiffFile | null;
  // Whether the file was too long to show whole.
  truncated: boolean;
}

export interface LineCounts {
  additions: number;
  deletions: number;
  // How many files changed, and how many of them the user marked reviewed as they are now.
  files: number;
  reviewed: number;
}

// A new item; its repository is owner/name or the folder of a checkout, and a checkout given is added to Repositories.
export type NewItem = Omit<ItemInput, "id"> & { checkout?: string };

export interface AddedItem {
  id: string;
  repository: string;
  // The issue it was linked to or opened, or null when it was given one or GitHub could not be reached.
  issue: IssueLink | null;
  // Whether its checkout was added to Repositories.
  checkout_added: boolean;
  // Why the issue could not be found or opened; the item is saved all the same.
  problem: string;
}

// A described item, with the folder of its repository's checkout on this computer when one was found.
export type ItemDraft = ItemInput & { checkout?: string };

export interface GitHubAccount {
  signed_in: boolean;
  account: string;
  // Why X-Dev cannot tell, such as gh not being installed; empty otherwise.
  problem: string;
}

export interface GitHubSignIn {
  // The one-time code to enter on GitHub's device page.
  code: string;
  url: string;
}

export interface IssueLink {
  number: number;
  // Whether X-Dev opened it rather than finding one already open.
  opened: boolean;
}

export const runner_method_names = [
  "get_runner",
  "set_runner_setting",
  "set_repository",
  "add_repository",
  "remove_repository",
  "start_run",
  "stop_run",
  "interject_run",
  "interrupt_run",
  "retry_run",
  "set_run_mode",
  "answer_permission",
  "answer_run",
  "discard_run",
  "add_item",
  "take_proposal",
  "describe_item",
  "link_issue",
  "sync_github",
  "get_github",
  "sign_in_github",
  "sign_out_github",
  "get_changes",
  "get_file_change",
  "revert_file",
  "list_run_changes",
] as const satisfies readonly (keyof RunnerMethods)[];
