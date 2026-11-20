// Keeps each item's GitHub issue in step with X-Dev through gh: the stage labels, a comment per report, the status sheet
// at the top of the body, closing it once the item is done, and the pull request with its checks. Every write is best
// effort: a failure is kept on the item to show and is tried again later, and never fails a run.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, eq, isNotNull, isNull, ne } from "@x-tech-laboratories/x-libs/drizzle";
import { CyclePoller, type Watched } from "@x-tech-laboratories/x-libs/server/poller";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of } from "../shared/feature.ts";
import { check_ci, check_secrets, gates_cleared, type GateResult } from "../shared/gates/model.ts";
import {
  checks_pending,
  comment_of_run,
  digest_of,
  read_mirror,
  read_pull_request,
  set_item_github,
  status_block,
  wanted_labels,
  with_status,
  type GitHubMirror,
  type PullRequest,
} from "../shared/items/github.ts";
import { proposed, read_status } from "../shared/items/model.ts";
import { items } from "../shared/items/schema.ts";
import { needs_input } from "../shared/runs/model.ts";
import { finish_run, find_run, update_run } from "../shared/runs/store.ts";
import { runs } from "../shared/runs/schema.ts";
import { done } from "../shared/stages/model.ts";
import { close_issue, edit_issue, ensure_labels, find_pull_request, post_comment, read_checks, update_comment, view_issue, view_pull_request, type PullRequestFound } from "./github.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface GitHubSyncOptions {
  database: () => SqlDatabase;
  // The gh program, read each time so a changed setting takes at once.
  program: () => string;
  // Runs after each change to the data, so history records it and the pages hear of it.
  after_write: () => void;
  // The name the page shows for a stage, for the comment of a discarded run.
  stage_label?: (id: string) => string;
  // How often, in seconds, the poller looks again: while checks run, and otherwise.
  checks_interval?: number;
  idle_interval?: number;
  // The time, for tests.
  now?: () => string;
}

export interface SyncOptions {
  // Looks for a pull request from the item's branch, as after a run, besides refreshing one already known.
  find_pull_request?: boolean;
}

export interface GitHubSync {
  // Brings one item's issue and pull request up to date; gives back what went wrong, or empty, and never throws.
  sync_item: (item_id: string, options?: SyncOptions) => Promise<string>;
  // Brings every open item up to date, as the poller does.
  sync_all: () => Promise<void>;
  // The gh program, for the ci gate.
  program: () => string;
  start: () => void;
  stop: () => void;
}

const default_checks_interval = 30;
const default_idle_interval = 300;

// ── Sync ─────────────────────────────────────────────────────────────────────

type ItemRow = typeof items.$inferSelect;

export function create_github_sync({ database, program, after_write, stage_label = (id) => id, checks_interval = default_checks_interval, idle_interval = default_idle_interval, now = () => new Date().toISOString() }: GitHubSyncOptions): GitHubSync {
  // One sync at a time per item, so a comment is never posted twice.
  const queues = new Map<string, Promise<unknown>>();

  function item_row(id: string): ItemRow | undefined {
    return drizzle_of(database()).select().from(items).where(eq(items.id, id)).get();
  }

  function item_runs(item_id: string) {
    return drizzle_of(database()).select().from(runs).where(eq(runs.item_id, item_id)).orderBy(asc(runs.started_at)).all();
  }

  // The pull request read again from GitHub: found from the branch when asked, else refreshed while open.
  async function refresh_pull_request(row: ItemRow, known: PullRequest | null, find: boolean): Promise<PullRequest | null> {
    let found: PullRequestFound | null = null;
    if (known && known.state === "open") found = await view_pull_request(row.repository, known.number, program());
    else if (find && row.branch) found = await find_pull_request(row.repository, row.branch, program());
    if (!found) return known;
    const checks = await read_checks(row.repository, found.number, program());
    const fresh = { ...found, checks, changed_at: known?.changed_at ?? "" };
    return JSON.stringify(fresh) === JSON.stringify(known) ? known : { ...fresh, changed_at: now() };
  }

  // A latest run held only by its ci gate is checked again against the checks just read, moving the item on once they pass.
  function recheck_ci(item_id: string, pull_request: PullRequest | null): boolean {
    const latest = drizzle_of(database())
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.item_id, item_id), ne(runs.state, "discarded")))
      .orderBy(asc(runs.started_at))
      .all()
      .at(-1);
    if (!latest) return false;
    const run = find_run(database(), latest.id);
    const held = run.gates.find((gate) => gate.gate === "ci" && gate.outcome === "failed");
    if (run.state !== "failed" || !held || run.overrides.some((override) => override.gate === "ci")) return false;
    const result = check_ci(pull_request);
    if (JSON.stringify(result) === JSON.stringify(held)) return false;
    const gates: GateResult[] = run.gates.map((gate) => (gate.gate === "ci" ? result : gate));
    update_run(database(), run.id, { gates });
    if (run.next && gates_cleared(gates, run.overrides)) finish_run(database(), { ...run, gates });
    return true;
  }

  async function sync_now(item_id: string, options: SyncOptions): Promise<string> {
    const first = item_row(item_id);
    if (!first || first.issue_number === null || first.stage === proposed) return "";
    const issue_number = first.issue_number;
    const repository = first.repository;
    const mirror: GitHubMirror = read_mirror(first.github);
    const known = read_pull_request(first.pull_request);
    const problems: string[] = [];
    let changed = false;

    try {
      // The pull request first, since its checks may move the item on before the labels are set.
      const pull_request = await refresh_pull_request(first, known, options.find_pull_request === true);
      if (pull_request !== known) {
        set_item_github(database(), item_id, { pull_request });
        changed = true;
      }
      if (recheck_ci(item_id, pull_request)) changed = true;

      const row = item_row(item_id)!;
      const item_runs_now = item_runs(item_id);

      // Each report as a comment of its own, a changed one edited in place, a discarded one marked.
      for (const run of item_runs_now) {
        const record = mirror.comments[run.id];
        if (run.state === "discarded" && !record) continue;
        const failed_gates = (JSON.parse(run.gates) as GateResult[]).filter((gate) => gate.outcome === "failed" && !(JSON.parse(run.overrides) as { gate: string }[]).some((override) => override.gate === gate.gate)).map((gate) => gate.gate);
        const body = comment_of_run({ id: run.id, stage_label: stage_label(run.stage), state: run.state, report: run.report, failed_gates });
        if (body === null) continue;
        const digest = digest_of(body);
        if (record?.digest === digest) continue;
        const secrets = check_secrets([], [{ name: `${stage_label(run.stage)} report`, text: body }]);
        if (secrets.outcome === "failed") {
          problems.push(`Not posted, since ${secrets.findings.join("; ")}.`);
          continue;
        }
        const kept = record ? await update_comment(repository, record.id, body, program()) : false;
        mirror.comments[run.id] = { id: kept && record ? record.id : await post_comment(repository, issue_number, body, program()), digest };
        changed = true;
      }

      // The stage labels, the status sheet in the body and closing, which need the issue as it is now.
      const latest = item_runs_now.filter((run) => run.state !== "discarded").at(-1);
      const waiting = latest?.state === "waiting" || (latest?.state === "done" && latest.next === needs_input);
      const labels = wanted_labels(row.stage, waiting);
      const block = status_block(read_status(row.status));
      const sheet_secrets = check_secrets([], [{ name: "status sheet", text: block }]);
      if (sheet_secrets.outcome === "failed") problems.push(`The status sheet was not mirrored, since ${sheet_secrets.findings.join("; ")}.`);
      const sheet = sheet_secrets.outcome === "failed" ? mirror.sheet : digest_of(block);
      const close = row.stage === done && !mirror.closed;
      if (labels.join() !== mirror.labels.join() || sheet !== mirror.sheet || close) {
        const issue = await view_issue(repository, issue_number, program());
        const present = issue.labels.filter((label) => label.startsWith("stage:"));
        const add_labels = labels.filter((label) => !present.includes(label));
        const remove_labels = present.filter((label) => !labels.includes(label));
        const body = sheet === mirror.sheet ? issue.body : with_status(issue.body, block);
        if (add_labels.length) await ensure_labels(repository, add_labels, program());
        if (add_labels.length || remove_labels.length || body !== issue.body) await edit_issue(repository, issue_number, { add_labels, remove_labels, ...(body !== issue.body ? { body } : {}) }, program());
        mirror.labels = labels;
        mirror.sheet = sheet;
        if (close && issue.open) await close_issue(repository, issue_number, program());
        mirror.closed = mirror.closed || close;
        changed = true;
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }

    const problem = problems.join("\n");
    if (problem !== mirror.problem || changed) {
      set_item_github(database(), item_id, { mirror: { ...mirror, problem, synced_at: changed ? now() : mirror.synced_at } });
      after_write();
    }
    return problem;
  }

  function sync_item(item_id: string, options: SyncOptions = {}): Promise<string> {
    const before = queues.get(item_id) ?? Promise.resolve();
    const next = before.then(() => sync_now(item_id, options)).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    queues.set(item_id, next);
    void next.then(() => {
      if (queues.get(item_id) === next) queues.delete(item_id);
    });
    return next;
  }

  // Open items with an issue, proposals left out.
  function items_to_sync(): ItemRow[] {
    return drizzle_of(database())
      .select()
      .from(items)
      .where(and(isNotNull(items.issue_number), ne(items.stage, proposed), isNull(items.closed_at)))
      .all();
  }

  async function sync_all(): Promise<void> {
    for (const row of items_to_sync()) await sync_item(row.id);
  }

  const watched: Watched = {
    id: "github",
    settings: { interval: idle_interval, job_poll: checks_interval },
    cycle: sync_all,
    busy: () => items_to_sync().some((row) => checks_pending(read_pull_request(row.pull_request))),
  };
  const poller = new CyclePoller(() => [watched], { error: (details, message) => console.error(message, details.err) });

  return { sync_item, sync_all, program, start: () => poller.start(), stop: () => poller.stop() };
}
