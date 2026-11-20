// What to tell the user about runs while X-Dev is not in front of them: a run that finished, failed, asked questions or
// made proposals, and a pull request whose checks finished, worked out from how things looked before and after a
// change, apart from how it is shown.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PullRequest } from "../items/github.ts";
import { app_link } from "../links.ts";
import type { RunState } from "./model.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export const notice_kinds = ["run_finished", "run_failed", "run_asked", "run_proposed", "checks_finished"] as const;

export type NoticeKind = (typeof notice_kinds)[number];

// The words the Notifications settings show for each kind.
export const notice_kind_labels: Record<NoticeKind, [label: string, hint: string]> = {
  run_finished: ["A run finished", "A stage run handed in its report and passed its gates."],
  run_failed: ["A run failed", "A stage run failed, or a gate held its change back."],
  run_asked: ["A run asked questions", "A stage run is waiting for your answers."],
  run_proposed: ["A run made proposals", "A stage run proposed new items, which wait in the inbox."],
  checks_finished: ["A pull request's checks finished", "Every check on an item's pull request has passed or failed."],
};

// One run as the notices compare it from one change to the next.
export interface RunSnapshot {
  id: string;
  item_id: string;
  item_title: string;
  stage: string;
  state: RunState;
  proposals: number;
  // The first line of its report's Done, its error, or its first question, whichever fits the notice.
  summary: string;
  error: string;
  question: string;
}

// What a run looked like when last seen running, and how many proposals it had made by then.
export interface SeenRun {
  state: RunState;
  proposals_before: number;
}

export interface RunNotice {
  kind: NoticeKind;
  // A newer notice with the same key replaces the older one.
  key: string;
  title: string;
  body: string;
  url: string;
}

// ── Rules ────────────────────────────────────────────────────────────────────

function state_notice(run: RunSnapshot, stage_label: string): Omit<RunNotice, "key" | "url"> | null {
  if (run.state === "done") return { kind: "run_finished", title: `${stage_label} finished: ${run.item_title}`, body: run.summary || "The report is ready." };
  if (run.state === "failed") return { kind: "run_failed", title: `${stage_label} failed: ${run.item_title}`, body: run.error.split("\n")[0] || "The run failed." };
  if (run.state === "waiting") return { kind: "run_asked", title: `${stage_label} has questions: ${run.item_title}`, body: run.question || "The run is waiting for your answers." };
  return null;
}

// The notices due for runs that stopped running since last seen, and what to remember of the runs for next time.
export function run_notices(seen: Map<string, SeenRun>, runs: RunSnapshot[], stage_label: (stage: string) => string): { notices: RunNotice[]; seen: Map<string, SeenRun> } {
  const notices: RunNotice[] = [];
  const next = new Map<string, SeenRun>();
  for (const run of runs) {
    const before = seen.get(run.id);
    const url = app_link(`#/items/${run.item_id}/${run.id}`);
    if (run.state === "running") {
      next.set(run.id, { state: run.state, proposals_before: before?.state === "running" ? before.proposals_before : run.proposals });
      continue;
    }
    if (before?.state !== "running") continue;
    const notice = state_notice(run, stage_label(run.stage));
    if (notice) notices.push({ ...notice, key: `item-${run.item_id}`, url });
    const made = run.proposals - before.proposals_before;
    if (made > 0) notices.push({ kind: "run_proposed", key: `proposals-${run.item_id}`, title: `${stage_label(run.stage)} proposed ${made === 1 ? "an item" : `${made} items`}: ${run.item_title}`, body: "They wait in the inbox on the board.", url: app_link("#/board") });
  }
  return { notices, seen: next };
}

// ── Pull requests ────────────────────────────────────────────────────────────

export interface PullRequestSnapshot {
  item_id: string;
  item_title: string;
  pull_request: PullRequest | null;
}

// The notices due for pull requests whose checks were running last time and are all done now, and which still run.
export function checks_notices(running: Set<string>, items: PullRequestSnapshot[]): { notices: RunNotice[]; running: Set<string> } {
  const notices: RunNotice[] = [];
  const next = new Set<string>();
  for (const { item_id, item_title, pull_request } of items) {
    if (!pull_request || pull_request.checks.length === 0) continue;
    if (pull_request.checks.some((check) => check.bucket === "pending")) {
      next.add(item_id);
      continue;
    }
    if (!running.has(item_id)) continue;
    const failed = pull_request.checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").length;
    notices.push({
      kind: "checks_finished",
      key: `checks-${item_id}`,
      title: `Checks ${failed ? "failed" : "passed"} on #${pull_request.number}: ${item_title}`,
      body: failed ? `${failed} of ${pull_request.checks.length} checks failed.` : `All ${pull_request.checks.length} checks passed.`,
      url: app_link(`#/items/${item_id}`),
    });
  }
  return { notices, running: next };
}

// ── Watching from elsewhere ──────────────────────────────────────────────────

export interface NoticeWatchOptions {
  // The runs under way and the ones named, such as through list_watched_runs on a daemon in another place.
  read_runs: (run_ids: string[]) => Promise<RunSnapshot[]>;
  read_pull_requests: () => Promise<PullRequestSnapshot[]>;
  stage_label: (stage: string) => string;
  // Whether this device shows a kind of notice.
  is_on: (kind: NoticeKind) => boolean | Promise<boolean>;
  show: (notice: RunNotice) => void;
}

// Watches a daemon reached through its calls, as a phone or a window connected to another computer does; the first
// check only learns what is under way, and checks close together run one after another.
export function watch_notices(options: NoticeWatchOptions): { check: () => Promise<void> } {
  let seen: Map<string, SeenRun> | null = null;
  let checks_running = new Set<string>();
  let running = Promise.resolve();

  async function look(): Promise<void> {
    const runs = run_notices(seen ?? new Map(), await options.read_runs([...(seen?.keys() ?? [])]), options.stage_label);
    const checks = checks_notices(checks_running, await options.read_pull_requests());
    const is_first = seen === null;
    seen = runs.seen;
    checks_running = checks.running;
    if (is_first) return;
    for (const notice of [...runs.notices, ...checks.notices]) if (await options.is_on(notice.kind)) options.show(notice);
  }

  return {
    check: () => (running = running.then(look, look)),
  };
}

// The open items' pull requests, from the items as list_items gives them, read with read_pull_request.
export function pull_request_snapshots(items: { id: string; title: string; pull_request: string; closed_at: string | null }[], read: (json: string) => PullRequest | null): PullRequestSnapshot[] {
  return items.filter((item) => item.closed_at === null && item.pull_request !== "").map((item) => ({ item_id: item.id, item_title: item.title, pull_request: read(item.pull_request) }));
}
