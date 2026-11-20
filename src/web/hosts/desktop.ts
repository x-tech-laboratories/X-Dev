// The desktop app's page: the preload has put the main process's calls on the window, which go to this computer's
// daemon or to the one on another computer that Settings → Connections chose.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import type { BackupClient } from "@x-tech-laboratories/x-libs/backup_protocol";
import type { CertificateClient } from "@x-tech-laboratories/x-libs/certificate_protocol";
import { LOCAL_CONNECTION_ID, type ConnectionClient } from "@x-tech-laboratories/x-libs/connection_protocol";
import type { EventsClient } from "@x-tech-laboratories/x-libs/electron/events";
import type { LocalMcpClient } from "@x-tech-laboratories/x-libs/local_mcp_protocol";

import { backups_api_name, connections_api_name, remote_access_api_name, certificates_api_name, desktop_api_name, device_api_name, events_api_name, dev_api_name, local_mcp_api_name, stages_api_name, runner_api_name, webhooks_api_name, type DeviceMethods, type DevEvents, type PageApi } from "../../shared/page_api.ts";
import type { DesktopMethods } from "../../shared/desktop.ts";
import type { RemoteAccessMethods } from "../../shared/remote_access.ts";
import type { RunnerMethods } from "../../shared/runs/runner.ts";
import type { StagesMethods } from "../../shared/stages/model.ts";
import type { DevMethods } from "../../shared/store.ts";
import type { WebhookMethods } from "../../shared/webhooks/model.ts";

// ── Api ──────────────────────────────────────────────────────────────────────

type DesktopWindow = Record<string, unknown>;

export function is_desktop(): boolean {
  return dev_api_name in window;
}

// The window starts again whenever another daemon is chosen, so where it runs is read once here.
export async function desktop_api(): Promise<PageApi> {
  const desktop = window as unknown as DesktopWindow;
  const events = desktop[events_api_name] as EventsClient<DevEvents>;
  const connections = desktop[connections_api_name] as ConnectionClient;
  const is_here = (await connections.list_connections()).current === LOCAL_CONNECTION_ID;
  // The tray opens the page on a route, such as the items.
  events.on("open", (route) => (location.hash = route));
  // Sync, the MCP server and who may connect belong to this computer's own daemon, so they show only while it is in use.
  const own_daemon = is_here
    ? {
        device: desktop[device_api_name] as Client<DeviceMethods>,
        local_mcp: desktop[local_mcp_api_name] as LocalMcpClient,
        remote_access: desktop[remote_access_api_name] as Client<RemoteAccessMethods>,
        daemon_is_here: true,
      }
    : { device: null };
  return {
    host: "desktop",
    calls: desktop[dev_api_name] as Client<DevMethods>,
    ...own_daemon,
    backups: desktop[backups_api_name] as BackupClient,
    certificates: desktop[certificates_api_name] as CertificateClient,
    desktop: desktop[desktop_api_name] as Client<DesktopMethods>,
    stages: desktop[stages_api_name] as Client<StagesMethods>,
    runner: desktop[runner_api_name] as Client<RunnerMethods>,
    github_webhook: desktop[webhooks_api_name] as Client<WebhookMethods>,
    connections,
    on_change: (listener) => events.on("changed", listener),
  };
}
