// What X-Dev mirrors from an item to its GitHub issue, worked out apart from gh: the stage labels, a comment per
// report, the status sheet at the top of the issue's body, and the pull request with its checks.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { eq } from "@x-tech-laboratories/x-libs/drizzle";

import { drizzle_of } from "../feature.ts";
import { status_sections, type StatusSheet } from "./model.ts";
import { items } from "./schema.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// How gh sorts a check: passed, failed, still running, skipped or cancelled.
export const check_buckets = ["pass", "fail", "pending", "skipping", "cancel"] as const;

export type CheckBucket = (typeof check_buckets)[number];

export interface PullRequestCheck {
  name: string;
  workflow: string;
  bucket: CheckBucket;
  link: string;
}

export const pull_request_states = ["open", "closed", "merged"] as const;

export type PullRequestState = (typeof pull_request_states)[number];

export interface PullRequest {
  number: number;
  url: string;
  state: PullRequestState;
  draft: boolean;
  checks: PullRequestCheck[];
  // When X-Dev last saw it change on GitHub.
  changed_at: string;
}

export interface MirroredComment {
  id: number;
  // A fingerprint of the text posted, so a changed report is posted again.
  digest: string;
}

export interface GitHubMirror {
  // The stage labels last put on the issue.
  labels: string[];
  // Each run's report comment, by run id.
  comments: Record<string, MirroredComment>;
  // A fingerprint of the status sheet last written to the issue's body.
  sheet: string;
  // Whether X-Dev closed the issue, or found it closed, once the item was done.
  closed: boolean;
  // Why the last attempt to reach GitHub failed, one line each; empty once it went through.
  problem: string;
  // When X-Dev last changed something on GitHub for the item, or saw its pull request change.
  synced_at: string | null;
}

export interface ItemGitHub {
  pull_request: PullRequest | null;
  mirror: GitHubMirror;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function empty_mirror(): GitHubMirror {
  return { labels: [], comments: {}, sheet: "", closed: false, problem: "", synced_at: null };
}

function parse(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json || "null") as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The mirror record as saved, missing or damaged fields empty.
export function read_mirror(json: string): GitHubMirror {
  const saved = parse(json) ?? {};
  const comments = saved.comments && typeof saved.comments === "object" ? (saved.comments as Record<string, Partial<MirroredComment>>) : {};
  return {
    labels: Array.isArray(saved.labels) ? saved.labels.filter((label): label is string => typeof label === "string") : [],
    comments: Object.fromEntries(Object.entries(comments).filter(([, comment]) => typeof comment?.id === "number" && typeof comment.digest === "string") as [string, MirroredComment][]),
    sheet: typeof saved.sheet === "string" ? saved.sheet : "",
    closed: saved.closed === true,
    problem: typeof saved.problem === "string" ? saved.problem : "",
    synced_at: typeof saved.synced_at === "string" ? saved.synced_at : null,
  };
}

// The pull request as saved, or null when there is none.
export function read_pull_request(json: string): PullRequest | null {
  const saved = parse(json);
  if (!saved || typeof saved.number !== "number" || typeof saved.url !== "string") return null;
  const checks = Array.isArray(saved.checks) ? (saved.checks as Partial<PullRequestCheck>[]) : [];
  return {
    number: saved.number,
    url: saved.url,
    state: pull_request_states.includes(saved.state as PullRequestState) ? (saved.state as PullRequestState) : "open",
    draft: saved.draft === true,
    checks: checks.map((check) => ({ name: String(check.name ?? ""), workflow: String(check.workflow ?? ""), bucket: check_buckets.includes(check.bucket as CheckBucket) ? (check.bucket as CheckBucket) : "pending", link: String(check.link ?? "") })),
    changed_at: typeof saved.changed_at === "string" ? saved.changed_at : "",
  };
}

// Whether any of the pull request's checks is still running.
export function checks_pending(pull_request: PullRequest | null): boolean {
  return pull_request?.state === "open" && pull_request.checks.some((check) => check.bucket === "pending");
}

// ── What goes to GitHub ──────────────────────────────────────────────────────

export const status_marker = "<!-- x-dev-status -->";
export const handoff_marker = "<!-- stage-handoff -->";
export const needs_input_label = "stage:needs-input";

// A short fingerprint of a text, so a change shows without keeping the text.
export function digest_of(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return `${text.length.toString(36)}-${hash.toString(36)}`;
}

// The labels the issue should carry: the item's stage, and needs-input while a run waits on the user.
export function wanted_labels(stage: string, waiting_on_user: boolean): string[] {
  return [`stage:${stage}`, ...(waiting_on_user ? [needs_input_label] : [])];
}

// The status sheet as the block kept at the top of the issue's body, between the markers.
export function status_block(sheet: StatusSheet): string {
  const sections = status_sections.filter((section) => sheet[section.key].trim()).map((section) => `**${section.label}**\n\n${sheet[section.key].trim()}`);
  return [status_marker, "### Status", "", ...(sections.length ? sections.join("\n\n").split("\n") : ["Nothing yet."]), "", "_Kept by X-Dev; edits here are replaced._", status_marker].join("\n");
}

// The issue's body with the status block in place of the old one, or put at the top, the rest left exactly as it was.
export function with_status(body: string, block: string): string {
  const start = body.indexOf(status_marker);
  const end = start < 0 ? -1 : body.indexOf(status_marker, start + status_marker.length);
  if (end < 0) return body ? `${block}\n\n${body}` : block;
  return `${body.slice(0, start)}${block}${body.slice(end + status_marker.length)}`;
}

export interface CommentRun {
  id: string;
  stage_label: string;
  state: string;
  report: string;
  // The gates that failed and were not passed over.
  failed_gates: string[];
}

// The comment a run's report becomes, a discarded run's saying so, or null for a run with nothing to post.
export function comment_of_run(run: CommentRun): string | null {
  const head = `${handoff_marker}\n<!-- x-dev-run: ${run.id} -->`;
  if (run.state === "discarded") return `${head}\n_This ${run.stage_label} run was discarded in X-Dev; its report no longer stands._`;
  if (!run.report.trim() || (run.state !== "done" && run.state !== "failed")) return null;
  const held = run.failed_gates.length ? `\n\n**Gates failed:** ${run.failed_gates.join(", ")}` : "";
  return `${head}\n${run.report.trim()}${held}`;
}

// ── Writing ──────────────────────────────────────────────────────────────────

// Saves what the mirror and the pull request now are; the caller records history.
export function set_item_github(database: SqlDatabase, id: string, changes: { mirror?: GitHubMirror; pull_request?: PullRequest | null }): void {
  drizzle_of(database)
    .update(items)
    .set({
      ...(changes.mirror ? { github: JSON.stringify(changes.mirror) } : {}),
      ...(changes.pull_request !== undefined ? { pull_request: changes.pull_request ? JSON.stringify(changes.pull_request) : "" } : {}),
    })
    .where(eq(items.id, id))
    .run();
}
