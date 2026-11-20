// A page's calls to a daemon on another computer, made from the page itself with this device's token, as the phone
// makes them: each call posted under its table's path, and the daemon's change events followed over a stream.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { LoginNeeded } from "@x-tech-laboratories/x-libs/web/states";

// ── Daemon ───────────────────────────────────────────────────────────────────

export interface RemoteDaemon {
  // Such as "https://dev.example.org", with no slash at the end.
  address: string;
  token: string;
}

export interface RemoteLink {
  // The daemon chosen now, or null while none is.
  daemon: () => RemoteDaemon | null;
  // Given by the daemon's event stream, so the page is not told of its own changes.
  client_id: () => string;
  fetch?: typeof fetch;
}

const no_daemon_text = "No daemon is chosen yet. Add one under Settings → Connections.";

// One call to the daemon, its arguments as a JSON list; a refusal throws the daemon's words.
export async function call_remote(link: RemoteLink, path: string, args: unknown[]): Promise<unknown> {
  const daemon = link.daemon();
  if (daemon === null) throw new Error(no_daemon_text);
  let response: Response;
  try {
    response = await (link.fetch ?? fetch)(`${daemon.address}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${daemon.token}`, "x-client-id": link.client_id() },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error(`The daemon at ${daemon.address} did not answer.`);
  }
  const text = await response.text();
  if (response.status === 401) throw new LoginNeeded("This device's sign-in was refused; add the daemon again under Settings → Connections.");
  if (!response.ok) throw new Error(error_text(text) || `The daemon answered ${response.status}.`);
  return text === "" ? undefined : JSON.parse(text);
}

// The words of a refusal, sent as JSON with an error or message, or as plain text.
function error_text(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    return String(parsed.error ?? parsed.message ?? text);
  } catch {
    return text;
  }
}

// Every call of a table by name, posted under its path, such as "/api/runner/"; the daemon refuses names it lacks.
export function remote_table<Methods extends Record<keyof Methods, (...args: never[]) => unknown>>(link: RemoteLink, prefix: string): Client<Methods> {
  return new Proxy({} as Client<Methods>, {
    get: (_target, name) => (typeof name === "string" && name !== "then" ? (...args: unknown[]) => call_remote(link, `${prefix}${name}`, args) : undefined),
  });
}

export interface RemoteAbilities {
  runner: boolean;
  stages: boolean;
  webhooks?: boolean;
}

// What the daemon lets this device do, or nothing while it cannot be asked.
export async function read_abilities(link: RemoteLink): Promise<RemoteAbilities> {
  const daemon = link.daemon();
  if (daemon === null) return { runner: false, stages: false };
  try {
    const response = await (link.fetch ?? fetch)(`${daemon.address}/api/abilities`, { headers: { authorization: `Bearer ${daemon.token}` } });
    return response.ok ? ((await response.json()) as RemoteAbilities) : { runner: false, stages: false };
  } catch {
    return { runner: false, stages: false };
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface FollowRemoteOptions {
  retry_ms?: number;
  on_connect?: () => void;
}

// One server-sent event's name and data, or null for a comment or keep-alive.
export function parse_remote_event(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

// Follows the daemon's change events with the token, reconnecting whenever the stream ends; returns how to stop.
export function follow_remote(link: RemoteLink, on_event: (event: string, data: string) => void, options: FollowRemoteOptions = {}): () => void {
  const retry_ms = options.retry_ms ?? 5000;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stream: AbortController | null = null;

  async function read(): Promise<void> {
    const daemon = link.daemon();
    if (daemon === null) return;
    stream = new AbortController();
    const response = await (link.fetch ?? fetch)(`${daemon.address}/api/events`, { headers: { accept: "text/event-stream", authorization: `Bearer ${daemon.token}` }, signal: stream.signal });
    if (!response.ok || !response.body) return void (await response.body?.cancel());
    options.on_connect?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const parsed = parse_remote_event(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        if (parsed) on_event(parsed.event, parsed.data);
      }
    }
  }

  function open(): void {
    void read()
      .catch(() => undefined)
      .finally(() => {
        stream = null;
        if (!stopped) retry = setTimeout(open, retry_ms);
      });
  }

  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    stream?.abort();
  };
}
