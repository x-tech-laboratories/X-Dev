// A browser's page: every call goes to the web server it was loaded from, and the server's event stream says when
// another page or device changed something.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { BackupClient } from "@x-tech-laboratories/x-libs/backup_protocol";
import type { SyncDeviceClient } from "@x-tech-laboratories/x-libs/sync_protocol";
import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { LoginNeeded } from "@x-tech-laboratories/x-libs/web/states";

import type { PageApi } from "../../shared/page_api.ts";
import type { RunnerMethods } from "../../shared/runs/runner.ts";
import type { StagesMethods } from "../../shared/stages/model.ts";
import type { DevMethods } from "../../shared/store.ts";
import type { WebhookMethods } from "../../shared/webhooks/model.ts";

// ── Server calls ─────────────────────────────────────────────────────────────

// Relative, so a server behind a proxy under a folder keeps it.
const call_path = "api/call/";
const backup_path = "api/backup/";
const stages_path = "api/stages/";
const sync_device_path = "api/sync_device/";
const runner_path = "api/runner/";
const webhook_path = "api/github_webhook/";
const abilities_path = "api/abilities";
const events_path = "api/events";
const client_id_header = "x-client-id";

// Given by the server when the page connects, so the page is not told about its own changes.
let client_id = "";

// A signed-out page shows the sign-in form rather than stale data.
async function call_server(method: string, args: unknown[], path = call_path): Promise<unknown> {
  const response = await fetch(path + method, {
    method: "POST",
    headers: { "content-type": "application/json", [client_id_header]: client_id },
    body: JSON.stringify(args),
  });
  if (response.status === 401) throw new LoginNeeded("Sign in first.");
  if (!response.ok) throw new Error(await response.text());
  const text = await response.text();
  return text === "" ? undefined : JSON.parse(text);
}

// ── Change events ────────────────────────────────────────────────────────────

const reconnect_delay_ms = 5000;

// A greeting after the first means the stream reconnected and may have missed changes, so the page reloads too.
function follow_changes(on_change: () => void): void {
  let has_connected = false;
  const connect = (): void => {
    const events = new EventSource(events_path);
    events.addEventListener("hello", (event) => {
      client_id = (event as MessageEvent<string>).data;
      if (has_connected) on_change();
      has_connected = true;
    });
    events.addEventListener("changed", on_change);
    // The browser retries a dropped stream by itself but gives up on a refused one, so the page tries again later.
    events.addEventListener("error", () => {
      if (events.readyState === EventSource.CLOSED) setTimeout(connect, reconnect_delay_ms);
    });
  };
  connect();
}

// ── Api ──────────────────────────────────────────────────────────────────────

// Any call by name goes to the server, which refuses names it does not know, so the page needs no list of them.
function server_calls(): Client<DevMethods> {
  return new Proxy({} as Client<DevMethods>, {
    get: (_target, name) => (typeof name === "string" ? (...args: unknown[]) => call_server(name, args) : undefined),
  });
}

// The server's own backups, which only an admin may take, restore or delete.
function server_backups(): BackupClient {
  return new Proxy({} as BackupClient, {
    get: (_target, name) => (typeof name === "string" ? (...args: unknown[]) => call_server(name, args, backup_path) : undefined),
  });
}

// Every call of a table that only an admin reaches, such as the stage files or the runner.
function server_table<Methods>(path: string): Methods {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => (typeof name === "string" && name !== "then" ? (...args: unknown[]) => call_server(name, args, path) : undefined),
  }) as Methods;
}

// What the server lets this user do: start runs where it runs agents, change stages and set up webhooks as an admin.
export async function read_server_abilities(): Promise<{ runner: boolean; stages: boolean; webhooks?: boolean }> {
  try {
    const response = await fetch(abilities_path);
    return response.ok ? ((await response.json()) as { runner: boolean; stages: boolean; webhooks?: boolean }) : { runner: false, stages: true };
  } catch {
    return { runner: false, stages: true };
  }
}

// A daemon that runs agents gives an admin its runner; until signed in the page asks again once it is.
export async function web_api(): Promise<PageApi> {
  const abilities = await read_server_abilities();
  const listeners = new Set<() => void>();
  follow_changes(() => {
    for (const listener of listeners) listener();
  });
  return {
    host: "web",
    calls: server_calls(),
    backups: server_backups(),
    stages: server_table<Client<StagesMethods>>(stages_path),
    // The server's own sync, which only an admin may pair devices with.
    server_sync: server_table<SyncDeviceClient>(sync_device_path),
    ...(abilities.runner ? { runner: server_table<Client<RunnerMethods>>(runner_path) } : {}),
    ...(abilities.webhooks ? { github_webhook: server_table<Client<WebhookMethods>>(webhook_path) } : {}),
    device: null,
    on_change: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
