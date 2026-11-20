// What the page asks of whichever host runs the agents, and that host's own settings, which belong to its computer.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ItemInput } from "../items/model.ts";

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
  answer_run: (run_id: string, answers: string) => void;
  discard_run: (run_id: string) => Promise<void>;
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
  "answer_run",
  "discard_run",
  "describe_item",
  "link_issue",
  "sync_github",
  "get_github",
  "sign_in_github",
  "sign_out_github",
] as const satisfies readonly (keyof RunnerMethods)[];
