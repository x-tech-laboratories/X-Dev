// Where the window's calls and change events go, this computer's daemon or one chosen elsewhere, and the notices the
// window shows for a daemon elsewhere, worked out apart from Electron.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Connections } from "@x-tech-laboratories/x-libs/connections";
import type { DaemonLink } from "@x-tech-laboratories/x-libs/daemon_link";
import type { SyncStatus } from "@x-tech-laboratories/x-libs/sync_protocol";

import type { DesktopSettings } from "../shared/desktop.ts";
import { read_pull_request } from "../shared/items/github.ts";
import type { Item } from "../shared/items/model.ts";
import { is_read_only } from "../shared/page_api.ts";
import { pull_request_snapshots, watch_notices, type RunNotice, type RunSnapshot } from "../shared/runs/notices.ts";
import type { StageList } from "../shared/stages/model.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface DaemonRouterOptions {
  connections: Pick<Connections, "current" | "subscribe">;
  link: Pick<DaemonLink, "call" | "follow_events">;
  // Posts one call to this computer's daemon over its socket.
  call_local: (path: string, args: unknown[], headers: Record<string, string>) => Promise<unknown>;
  // Starts this computer's daemon again after it went away.
  restart_local: () => Promise<unknown>;
  // The windows hear that the data changed.
  on_change: () => void;
  on_sync_status: (status: SyncStatus) => void;
  // Another daemon was chosen, so every window starts again on it.
  on_switch: () => void;
  // A call that changes something was made, such as for the tray to count again.
  after_write: () => void;
  show_notice: (notice: RunNotice) => void;
}

export type DaemonRouter = ReturnType<typeof create_daemon_router>;

// Calls that belong to this computer whichever daemon the window uses: its sync, certificates, MCP, own settings and who may connect.
export const local_tables = new Set(["device", "certificates", "local_mcp", "daemon", "remote"]);

// ── Router ───────────────────────────────────────────────────────────────────

export function create_daemon_router(options: DaemonRouterOptions) {
  const { connections, link } = options;
  // Given by the chosen daemon when this process connects, so the window is not told about its own changes.
  let client_id = "";
  let is_quitting = false;
  let stop_following = (): void => {};
  let remote_notices: ReturnType<typeof watch_notices> | null = null;
  let stage_labels = new Map<string, string>();

  function is_here(): boolean {
    return connections.current()?.kind !== "remote";
  }

  // One call, as the page made it, to this computer's daemon or the chosen one.
  async function call(path: string, args: unknown[]): Promise<unknown> {
    const headers = { "x-client-id": client_id };
    const is_local = local_tables.has(path.slice(0, path.indexOf("/")));
    const result = is_local ? await options.call_local(`/api/${path}`, args, is_here() ? headers : {}) : await link.call(`/api/${path}`, args, headers);
    if (!is_read_only(path.slice(path.lastIndexOf("/") + 1))) options.after_write();
    return result;
  }

  // Every call in a table, passed on under a path of its own.
  function forwarded(names: readonly string[], prefix: string | (() => string)): Record<string, (...args: unknown[]) => Promise<unknown>> {
    const prefix_now = typeof prefix === "string" ? () => prefix : prefix;
    return Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => call(`${prefix_now()}/${name}`, args)]));
  }

  function get_desktop_settings(): Promise<DesktopSettings> {
    return call("daemon/get_desktop_settings", []) as Promise<DesktopSettings>;
  }

  function check_notices(): Promise<void> {
    return remote_notices?.check() ?? Promise.resolve();
  }

  function announce_change(): void {
    options.on_change();
    void check_notices().catch(() => undefined);
  }

  // This computer's daemon tells of its own runs; for a daemon elsewhere the window tells, by the kinds switched on here.
  function watch_remote_notices(): void {
    remote_notices = null;
    if (is_here()) return;
    remote_notices = watch_notices({
      read_runs: async (run_ids) => {
        const stages = (await call("stages/list_stages", []).catch(() => null)) as StageList | null;
        if (stages) stage_labels = new Map(stages.stages.map((stage) => [stage.id, stage.label]));
        return (await call("call/list_watched_runs", [run_ids])) as RunSnapshot[];
      },
      read_pull_requests: async () => pull_request_snapshots((await call("call/list_items", [false])) as Item[], read_pull_request),
      stage_label: (stage) => stage_labels.get(stage) ?? stage,
      is_on: async (kind) => (await get_desktop_settings())[`notify_${kind}`],
      show: options.show_notice,
    });
    void check_notices().catch(() => undefined);
  }

  // The chosen daemon's changes reach every window, and this computer's daemon starts again when it stopped.
  function follow(): void {
    stop_following = link.follow_events(
      "/api/events",
      (event, data) => {
        if (event === "hello") client_id = data;
        if (event === "changed") announce_change();
        if (event === "sync_status") options.on_sync_status(JSON.parse(data) as SyncStatus);
      },
      {
        // A reconnect may have missed changes, so the windows fetch again.
        on_connect: announce_change,
        on_disconnect: () => {
          if (!is_quitting && is_here()) void options.restart_local().catch((error: unknown) => console.error(error));
        },
      },
    );
  }

  const unsubscribe = connections.subscribe(() => {
    client_id = "";
    watch_remote_notices();
    options.on_switch();
  });

  return {
    is_here,
    call,
    forwarded,
    get_desktop_settings,
    check_notices,
    // Follows the chosen daemon's events and, when it is elsewhere, watches it for notices.
    start: () => {
      follow();
      watch_remote_notices();
    },
    // The app is going, so a daemon that goes away is not started again.
    quitting: () => {
      is_quitting = true;
    },
    stop: () => {
      is_quitting = true;
      unsubscribe();
      stop_following();
    },
  };
}
