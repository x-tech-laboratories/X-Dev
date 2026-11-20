// What the page knows of its host without loading the store: the names the calls travel under, and the api's shape.
// The browser build imports only this, so the stores and Drizzle stay out of the page a server serves.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { backup_method_names, type BackupClient, type BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import type { CertificateClient } from "@x-tech-laboratories/x-libs/certificate_protocol";
import type { ConnectionClient } from "@x-tech-laboratories/x-libs/connection_protocol";
import type { LocalMcpClient } from "@x-tech-laboratories/x-libs/local_mcp_protocol";
import { sync_device_method_names, type SyncDeviceMethods, type SyncStatus } from "@x-tech-laboratories/x-libs/sync_protocol";

import type { DesktopMethods } from "./desktop.ts";
import type { RemoteAccessMethods } from "./remote_access.ts";
import type { NoticeKind } from "./runs/notices.ts";
import type { RunnerMethods } from "./runs/runner.ts";
import type { StagesMethods } from "./stages/model.ts";
import type { DevMethods } from "./store.ts";

// ── Names ────────────────────────────────────────────────────────────────────

export const dev_api_name = "x_dev";
export const device_api_name = "x_dev_device";
export const events_api_name = "x_dev_events";
export const certificates_api_name = "x_dev_certificates";
export const local_mcp_api_name = "x_dev_local_mcp";
export const desktop_api_name = "x_dev_desktop";
export const stages_api_name = "x_dev_stages";
export const runner_api_name = "x_dev_runner";
export const connections_api_name = "x_dev_connections";
export const remote_access_api_name = "x_dev_remote";
export const backups_api_name = "x_dev_backups";

// ── Device calls ─────────────────────────────────────────────────────────────

// Sync with a server and backups of the device's own database; a browser is already on the server.
export type DeviceMethods = SyncDeviceMethods & BackupMethods;

export const device_method_names = [...sync_device_method_names, ...backup_method_names] as const;

// What the main process tells the page on its own: the data changed elsewhere, sync's status moved, or the tray asked
// for a route such as "#/items".
export type DevEvents = { changed: null; sync_status: SyncStatus; open: string };

// ── The page's api ───────────────────────────────────────────────────────────

export type Host = "web" | "desktop" | "android";

export interface PageApi {
  host: Host;
  calls: Client<DevMethods>;
  // Null in a browser, which syncs nothing itself.
  device: Client<DeviceMethods> | null;
  // The backups of whichever database the page works on: the device's own, or the server's for a browser; left out where
  // none are offered, and Settings then shows no Backups section.
  backups?: BackupClient;
  // Set where the app makes its own connections and can trust a certificate the system refuses.
  certificates?: CertificateClient;
  // Set on the desktop, which can serve its own MCP endpoint to AI clients on the same computer.
  local_mcp?: LocalMcpClient;
  // The stage files, kept by the daemon or the server that runs the agents; left out on a phone.
  stages?: Client<StagesMethods>;
  // The runner, on a daemon that runs the agents in its computer's checkouts, for an admin when it is elsewhere.
  runner?: Client<RunnerMethods>;
  // Set when the daemon runs on the computer showing the page, so a folder can be picked in its own dialog.
  daemon_is_here?: boolean;
  // The daemons a desktop or phone app can switch between, This computer among them on the desktop.
  connections?: ConnectionClient;
  // Letting other devices connect to this computer's daemon; set only on the desktop while it uses its own daemon.
  remote_access?: Client<RemoteAccessMethods>;
  // Which kinds of notification a phone shows, kept on the phone; the desktop keeps its own with its other settings.
  notice_kinds?: { get: () => Promise<Record<NoticeKind, boolean>>; set: (kind: NoticeKind, on: boolean) => Promise<void> };
  // Set on the desktop, whose tray, background running and start at login belong to the computer.
  desktop?: Client<DesktopMethods>;
  // Runs whenever the data changed somewhere else; returns the function that stops listening.
  on_change: (listener: () => void) => () => void;
}

// ── Calls ────────────────────────────────────────────────────────────────────

// A call that only reads; any other call announces a change.
export function is_read_only(method: string): boolean {
  return /^(list|get|search|lookup|export)_/.test(method);
}
