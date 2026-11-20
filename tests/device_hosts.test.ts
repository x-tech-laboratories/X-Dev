// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin_calls = vi.hoisted(() => ({ scheduled: [] as unknown[], listeners: [] as string[] }));

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async (event: string) => void plugin_calls.listeners.push(event)) } }));
vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    getPending: vi.fn(async () => ({ notifications: [] })),
    cancel: vi.fn(async () => undefined),
    checkPermissions: vi.fn(async () => ({ display: "granted" })),
    requestPermissions: vi.fn(async () => ({ display: "granted" })),
    schedule: vi.fn(async (options: { notifications: unknown[] }) => void plugin_calls.scheduled.push(...options.notifications)),
    addListener: vi.fn(async () => undefined),
  },
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({}) }));

import { android_api } from "../src/web/hosts/android.ts";
import { desktop_api } from "../src/web/hosts/desktop.ts";

const daemon = { id: "home", name: "Workstation", address: "https://dev.example.org:7760", user: "root", token: "phone-token" };

beforeEach(() => {
  localStorage.clear();
  plugin_calls.scheduled.length = 0;
  plugin_calls.listeners.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of Object.keys(window).filter((key) => key.startsWith("x_dev"))) delete (window as unknown as Record<string, unknown>)[name];
});

// ============================================================================
// Phone
// ============================================================================

// A daemon that answers the phone's calls, streams one change after the page connects, and records what it was asked.
function fake_daemon(abilities: { runner: boolean; stages: boolean }, runs: () => unknown[]) {
  const asked: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const send_change = () => stream?.enqueue(new TextEncoder().encode("event: changed\ndata: null\n\n"));
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(daemon.address, "");
    asked.push(path);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${daemon.token}`);
    if (path === "/api/abilities") return new Response(JSON.stringify(abilities));
    if (path === "/api/events") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode("event: hello\ndata: client-1\n\n"));
        },
      });
      return new Response(body);
    }
    if (path === "/api/call/list_watched_runs") return new Response(JSON.stringify(runs()));
    if (path === "/api/call/list_items") return new Response("[]");
    if (path === "/api/stages/list_stages") return new Response(JSON.stringify({ folder: "", stages: [{ id: "plan", label: "Plan" }], problems: [] }));
    if (path === "/api/runner/start_run") return new Response(JSON.stringify("run-1"));
    return new Response("null");
  });
  vi.stubGlobal("fetch", fetch);
  return { asked, fetch, send_change };
}

const run = (state: string) => ({ id: "r1", item_id: "i1", item_title: "Swimlanes", stage: "plan", state, proposals: 0, summary: "", error: "", question: "Lanes or tabs?" });

describe("the phone's page", () => {
  it("works on no daemon until one is added", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const api = await android_api();

    expect(api.host).toBe("android");
    expect((await api.connections!.list_connections()).current).toBeNull();
    await expect(api.calls.list_items(false)).rejects.toThrow("Settings → Connections");
    expect(api.runner).toBeUndefined();
  });

  it("starts runs on the daemon it connects to, and tells of a run that asked", async () => {
    localStorage.setItem("x-dev-connections", JSON.stringify({ current: "home", remotes: [daemon] }));
    let state = "running";
    const { asked, fetch, send_change } = fake_daemon({ runner: true, stages: true }, () => [run(state)]);
    const api = await android_api();

    expect(api.daemon_is_here).toBeUndefined();
    expect(await api.runner!.start_run("i1", {})).toBe("run-1");
    expect(fetch).toHaveBeenCalledWith(`${daemon.address}/api/runner/start_run`, expect.objectContaining({ body: JSON.stringify(["i1", {}]) }));
    await vi.waitFor(() => expect(asked).toContain("/api/call/list_watched_runs"));

    state = "waiting";
    send_change();
    await vi.waitFor(() => expect(plugin_calls.scheduled).toEqual([expect.objectContaining({ title: "Plan has questions: Swimlanes", body: "Lanes or tabs?", extra: { url: "x-dev://items/i1/r1" } })]), { timeout: 2000 });
    expect(plugin_calls.listeners).toContain("resume");
  });

  it("leaves out the runner and stages for a user who is not an admin", async () => {
    localStorage.setItem("x-dev-connections", JSON.stringify({ current: "home", remotes: [daemon] }));
    fake_daemon({ runner: false, stages: false }, () => []);
    const api = await android_api();

    expect(api.runner).toBeUndefined();
    expect(api.stages).toBeUndefined();
    expect(api.backups).toBeUndefined();
    await api.notice_kinds!.set("run_failed", false);
    expect((await api.notice_kinds!.get()).run_failed).toBe(false);
  });
});

// ============================================================================
// Desktop
// ============================================================================

function desktop_window(current: string) {
  const bridges = Object.fromEntries(["x_dev", "x_dev_device", "x_dev_certificates", "x_dev_local_mcp", "x_dev_desktop", "x_dev_stages", "x_dev_runner", "x_dev_remote", "x_dev_backups"].map((name) => [name, { name }]));
  const events = { on: vi.fn(() => () => undefined) };
  const connections = { list_connections: vi.fn(async () => ({ connections: [], current })) };
  Object.assign(window, bridges, { x_dev_events: events, x_dev_connections: connections });
  return bridges;
}

describe("the desktop page", () => {
  it("offers sync, the MCP server and other devices while on this computer's daemon", async () => {
    const bridges = desktop_window("local");
    const api = await desktop_api();

    expect(api).toMatchObject({ host: "desktop", daemon_is_here: true, device: bridges.x_dev_device, local_mcp: bridges.x_dev_local_mcp, remote_access: bridges.x_dev_remote, runner: bridges.x_dev_runner });
  });

  it("leaves this computer's own settings out while on a daemon elsewhere", async () => {
    const bridges = desktop_window("home");
    const api = await desktop_api();

    expect(api.device).toBeNull();
    expect(api.daemon_is_here).toBeUndefined();
    expect(api.remote_access).toBeUndefined();
    expect(api.local_mcp).toBeUndefined();
    expect(api.backups).toBe(bridges.x_dev_backups);
    expect(api.runner).toBe(bridges.x_dev_runner);
  });
});
