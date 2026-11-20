// The bridges the desktop app's main process and preload use, and the web server's call table.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_bridge } from "@x-tech-laboratories/x-libs/electron/bridge";
import { backup_method_names, type BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import { certificate_method_names, type CertificateMethods } from "@x-tech-laboratories/x-libs/certificate_protocol";
import { connection_method_names, type ConnectionMethods } from "@x-tech-laboratories/x-libs/connection_protocol";
import { local_mcp_method_names, type LocalMcpMethods } from "@x-tech-laboratories/x-libs/local_mcp_protocol";
import { define_events } from "@x-tech-laboratories/x-libs/electron/events";

import { desktop_method_names, type DesktopMethods } from "./desktop.ts";
import { remote_access_method_names, type RemoteAccessMethods } from "./remote_access.ts";
import { runner_method_names, type RunnerMethods } from "./runs/runner.ts";
import { stages_method_names, type StagesMethods } from "./stages/model.ts";
import { backups_api_name, connections_api_name, remote_access_api_name, certificates_api_name, desktop_api_name, stages_api_name, runner_api_name, device_api_name, local_mcp_api_name, webhooks_api_name, device_method_names, events_api_name, dev_api_name, type DeviceMethods, type DevEvents } from "./page_api.ts";
import { method_names, type DevMethods } from "./store.ts";
import { webhook_method_names, type WebhookMethods } from "./webhooks/model.ts";

// ── Bridges ──────────────────────────────────────────────────────────────────

export const dev_bridge = define_bridge<DevMethods>(dev_api_name, method_names);

export const device_bridge = define_bridge<DeviceMethods>(device_api_name, device_method_names);

// Server certificates the user chose to trust, such as a home sync server's self-signed one.
export const certificate_bridge = define_bridge<CertificateMethods>(certificates_api_name, certificate_method_names);

// The desktop app's own MCP endpoint, for AI clients on the same computer.
export const local_mcp_bridge = define_bridge<LocalMcpMethods>(local_mcp_api_name, local_mcp_method_names);

// The desktop app's own settings and quitting, answered by the main process.
export const desktop_bridge = define_bridge<DesktopMethods>(desktop_api_name, desktop_method_names);

// The stage files, answered by the daemon.
export const stages_bridge = define_bridge<StagesMethods>(stages_api_name, stages_method_names);

// The runner, answered by the daemon.
export const runner_bridge = define_bridge<RunnerMethods>(runner_api_name, runner_method_names);

// The daemons this desktop app can connect to, kept by the main process.
export const connection_bridge = define_bridge<ConnectionMethods>(connections_api_name, connection_method_names);

// Letting other devices reach this computer's daemon, answered by the daemon over its socket alone.
export const remote_access_bridge = define_bridge<RemoteAccessMethods>(remote_access_api_name, remote_access_method_names);

// The backups of whichever daemon the window uses: this computer's, or an admin's view of another's.
export const backup_bridge = define_bridge<BackupMethods>(backups_api_name, backup_method_names);

// GitHub's webhooks on whichever daemon the window uses, answered by that daemon.
export const webhook_bridge = define_bridge<WebhookMethods>(webhooks_api_name, webhook_method_names);

export const dev_events = define_events<DevEvents>(events_api_name);
