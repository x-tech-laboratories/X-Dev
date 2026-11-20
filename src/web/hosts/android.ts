// The phone's page: a window onto an X-Dev daemon on another computer, the one that holds the checkouts and runs the
// agents, chosen under Settings → Connections and signed in once as this phone. Every call goes there with the phone's
// token, its change events keep the page current, and runs that finish, fail or ask are told as phone notifications.

// ── Imports ──────────────────────────────────────────────────────────────────

import { App } from "@capacitor/app";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { BackupClient } from "@x-tech-laboratories/x-libs/backup_protocol";
import { create_connections } from "@x-tech-laboratories/x-libs/connections";
import { notice_id } from "@x-tech-laboratories/x-libs/phone_notices";
import { phone_certificates } from "@x-tech-laboratories/x-libs/phone_certificates";
import { local_connection_storage } from "@x-tech-laboratories/x-libs/web/connection_storage";

import { read_pull_request } from "../../shared/items/github.ts";
import type { Item } from "../../shared/items/model.ts";
import { route_of_link } from "../../shared/links.ts";
import type { PageApi } from "../../shared/page_api.ts";
import { notice_kinds, pull_request_snapshots, watch_notices, type NoticeKind } from "../../shared/runs/notices.ts";
import type { RunnerMethods } from "../../shared/runs/runner.ts";
import type { StagesMethods } from "../../shared/stages/model.ts";
import type { DevMethods } from "../../shared/store.ts";
import { follow_remote, read_abilities, remote_table, type RemoteLink } from "./remote.ts";

// ── Storage ──────────────────────────────────────────────────────────────────

// The daemons and their tokens stay in the app's own storage, which no other app reads.
const connections_key = "x-dev-connections";
const notice_kinds_key = "x-dev-notice-kinds";

// Which kinds of notification this phone shows; all of them unless turned off.
export function read_notice_kinds(saved: string | null): Record<NoticeKind, boolean> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(saved ?? "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return Object.fromEntries(notice_kinds.map((kind) => [kind, parsed[kind] !== false])) as Record<NoticeKind, boolean>;
}

// ── Notices ──────────────────────────────────────────────────────────────────

// Run notices show at once and never ask for exact alarms, which would open a settings screen; a tap opens the item.
export function phone_notices(plugin: typeof LocalNotifications, open_route: (route: string) => void): { show: (title: string, body: string, key: string, url: string) => void } {
  void plugin.addListener("localNotificationActionPerformed", (action) => {
    const route = route_of_link(String((action.notification.extra as { url?: unknown } | undefined)?.url ?? ""));
    if (route) open_route(route);
  });
  void plugin.checkPermissions().then(({ display }) => (display === "granted" || display === "denied" ? undefined : plugin.requestPermissions()));
  return {
    show: (title, body, key, url) => void plugin.schedule({ notifications: [{ id: notice_id(key), title, body, extra: { url }, isExactNotification: false }] }).catch((error: unknown) => console.error("could not show a notice", error)),
  };
}

// ── Api ──────────────────────────────────────────────────────────────────────

export async function android_api(): Promise<PageApi> {
  const connections = create_connections({ storage: local_connection_storage(connections_key), offers_local: false, device_name: "X-Dev on Android" });
  let client_id = "";
  const link: RemoteLink = {
    daemon: () => {
      const current = connections.current();
      return current?.kind === "remote" ? { address: current.address, token: current.token } : null;
    },
    client_id: () => client_id,
  };
  // Another daemon chosen, or one added first: the page starts again on it.
  connections.subscribe(() => location.reload());

  const listeners = new Set<() => void>();
  const announce = (): void => {
    for (const listener of listeners) listener();
  };

  const calls = remote_table<DevMethods>(link, "/api/call/");
  const stages = remote_table<StagesMethods>(link, "/api/stages/");
  const runner = remote_table<RunnerMethods>(link, "/api/runner/");
  const abilities = await read_abilities(link);

  // Notices are worked out here while the app is open, since the phone has no daemon of its own.
  let stage_labels = new Map<string, string>();
  const shown = phone_notices(LocalNotifications, (route) => (location.hash = route));
  const notices = watch_notices({
    read_runs: async (run_ids) => {
      if (abilities.stages) stage_labels = new Map((await stages.list_stages()).stages.map((stage) => [stage.id, stage.label]));
      return calls.list_watched_runs(run_ids);
    },
    read_pull_requests: async () => pull_request_snapshots((await calls.list_items(false)) as Item[], read_pull_request),
    stage_label: (stage) => stage_labels.get(stage) ?? stage,
    is_on: (kind) => read_notice_kinds(localStorage.getItem(notice_kinds_key))[kind],
    show: (notice) => shown.show(notice.title, notice.body, notice.key, notice.url),
  });
  const look = (): void => void notices.check().catch(() => undefined);

  if (link.daemon()) {
    follow_remote(
      link,
      (event, data) => {
        if (event === "hello") client_id = data;
        if (event === "changed") {
          announce();
          look();
        }
      },
      // A reconnect may have missed changes, so the page reads again.
      { on_connect: () => (announce(), look()) },
    );
    // Back from the background, the page catches up on what it missed.
    void App.addListener("resume", () => (announce(), look()));
  }

  return {
    host: "android",
    calls,
    device: null,
    connections: connections.methods,
    certificates: phone_certificates(),
    ...(abilities.stages ? { stages, backups: remote_table<BackupClient>(link, "/api/backup/") as BackupClient } : {}),
    ...(abilities.runner ? { runner } : {}),
    notice_kinds: {
      get: async () => read_notice_kinds(localStorage.getItem(notice_kinds_key)),
      set: async (kind, on) => localStorage.setItem(notice_kinds_key, JSON.stringify({ ...read_notice_kinds(localStorage.getItem(notice_kinds_key)), [kind]: on })),
    },
    on_change: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
