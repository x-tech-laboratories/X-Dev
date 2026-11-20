// What to tell the user about runs while X-Dev is not in front of them: a run that finished, failed, asked questions,
// waits for a tool call to be approved or made proposals, and a pull request whose checks finished, worked out from how things looked before and after a
// change, apart from how it is shown.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PullRequest } from "../items/github.ts";
import { app_link } from "../links.ts";
import type { RunState } from "./model.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export const notice_kinds = ["run_finished", "run_failed", "run_asked", "run_approval", "run_proposed", "checks_finished"] as const;

export type NoticeKind = (typeof notice_kinds)[number];

// The words the Notifications settings show for each kind.
export const notice_kind_labels: Record<NoticeKind, [label: string, hint: string]> = {
  run_finished: ["A run finished", "A stage run handed in its report and passed its gates."],
  run_failed: ["A run failed", "A stage run failed, or a gate held its change back."],
  run_asked: ["A run asked questions", "A stage run is waiting for your answers."],
  run_approval: ["A run waits for approval", "A stage run in Manual or Edit automatically mode waits for you to allow or deny a tool call."],
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
  // The tool waiting for the user's approval, empty when none waits.
  awaiting: string;
}

// What a run looked like when last seen running, and how many proposals it had made by then.
export interface SeenRun {
  state: RunState;
  proposals_before: number;
  // The tool it waited on for approval when last seen.
  awaiting?: string;
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
      next.set(run.id, { state: run.state, proposals_before: before?.state === "running" ? before.proposals_before : run.proposals, awaiting: run.awaiting });
      if (before && run.awaiting && run.awaiting !== before.awaiting) {
        notices.push({ kind: "run_approval", key: `item-${run.item_id}`, title: `${stage_label(run.stage)} waits for approval: ${run.item_title}`, body: `Allow or deny ${run.awaiting} to let the run go on.`, url });
      }
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

// Watches a daemon elsewhere through its calls; the first check only learns what is under way, and checks run in turn.
export function watch_notices(options: NoticeWatchOptions): { check: () => Promise<void> } {
  // Each run under way or waiting as last seen, since changes far apart may pass over its running.
  let known: Map<string, { state: RunState; proposals: number }> | null = null;
  let checks_running = new Set<string>();
  let running = Promise.resolve();

  async function look(): Promise<void> {
    const watched = [...(known ?? new Map())].filter(([, run]) => run.state === "running" || run.state === "waiting").map(([id]) => id);
    const runs = await options.read_runs(watched);
    // A run whose state moved since last seen counts as having run in between.
    const seen = new Map<string, SeenRun>();
    for (const run of runs) {
      const before = known?.get(run.id);
      if (before && (before.state !== run.state || before.state === "running")) seen.set(run.id, { state: "running", proposals_before: before.proposals });
    }
    const notices = run_notices(seen, runs, options.stage_label).notices;
    const checks = checks_notices(checks_running, await options.read_pull_requests());
    const is_first = known === null;
    const before = known;
    known = new Map(runs.map((run) => [run.id, { state: run.state, proposals: before?.get(run.id)?.state === "running" && run.state === "running" ? before.get(run.id)!.proposals : run.proposals }]));
    checks_running = checks.running;
    if (is_first) return;
    for (const notice of [...notices, ...checks.notices]) if (await options.is_on(notice.kind)) options.show(notice);
  }

  return {
    check: () => (running = running.then(look, look)),
  };
}

// The open items' pull requests, from the items as list_items gives them, read with read_pull_request.
export function pull_request_snapshots(items: { id: string; title: string; pull_request: string; closed_at: string | null }[], read: (json: string) => PullRequest | null): PullRequestSnapshot[] {
  return items.filter((item) => item.closed_at === null && item.pull_request !== "").map((item) => ({ item_id: item.id, item_title: item.title, pull_request: read(item.pull_request) }));
}
