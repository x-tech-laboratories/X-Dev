// The daemon's notifications about runs and pull requests: after each change it compares them with how they looked
// before and shows, through X-Libs' desktop notifier, the kinds this computer has switched on.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Notifier } from "@x-tech-laboratories/x-libs/agent/desktop_notify";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { DesktopSettings } from "../shared/desktop.ts";
import { read_pull_request } from "../shared/items/github.ts";
import { runs_feature } from "../shared/runs/store.ts";
import { checks_notices, run_notices, type NoticeKind, type PullRequestSnapshot, type RunNotice, type RunSnapshot, type SeenRun } from "../shared/runs/notices.ts";

// ── Watching ─────────────────────────────────────────────────────────────────

const setting_of: Record<NoticeKind, keyof DesktopSettings> = {
  run_finished: "notify_run_finished",
  run_failed: "notify_run_failed",
  run_asked: "notify_run_asked",
  run_approval: "notify_run_approval",
  run_proposed: "notify_run_proposed",
  checks_finished: "notify_checks_finished",
};

export interface RunNoticeOptions {
  database: () => SqlDatabase;
  notifier: Pick<Notifier, "show">;
  settings: () => DesktopSettings;
  // The stage's name as the page shows it, such as Plan for plan.
  stage_label: (stage: string) => string;
}

// Watches the runs from now on, the ones already running included; check() after each change shows what is due.
export function watch_run_notices({ database, notifier, settings, stage_label }: RunNoticeOptions): { check: () => void } {
  let seen = new Map<string, SeenRun>();
  let checks_running = new Set<string>();

  // The runs under way, and those that were under way last time, as they are now.
  function read(): RunSnapshot[] {
    return runs_feature.methods.list_watched_runs(database(), [...seen.keys()]);
  }

  // The open items' pull requests.
  function read_pull_requests(): PullRequestSnapshot[] {
    const rows = database().prepare("SELECT id, title, pull_request FROM items WHERE closed_at IS NULL AND pull_request != ''").all() as unknown as { id: string; title: string; pull_request: string }[];
    return rows.map((row) => ({ item_id: row.id, item_title: row.title, pull_request: read_pull_request(row.pull_request) }));
  }

  function check(): void {
    const runs = run_notices(seen, read(), stage_label);
    const checks = checks_notices(checks_running, read_pull_requests());
    seen = runs.seen;
    checks_running = checks.running;
    const allowed = settings();
    const show = (notice: RunNotice) => void notifier.show({ title: notice.title, body: notice.body, key: notice.key, url: notice.url, icon: "app" });
    for (const notice of [...runs.notices, ...checks.notices]) if (allowed[setting_of[notice.kind]]) show(notice);
  }

  seen = run_notices(seen, read(), stage_label).seen;
  checks_running = checks_notices(checks_running, read_pull_requests()).running;
  return { check };
}
