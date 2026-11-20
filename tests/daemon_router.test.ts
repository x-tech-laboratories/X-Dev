// The desktop main process's choice of daemon, against this computer's daemon on a socket and one elsewhere on loopback.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { create_connections } from "@x-tech-laboratories/x-libs/connections";
import { create_daemon_link } from "@x-tech-laboratories/x-libs/daemon_link";
import { call_daemon } from "@x-tech-laboratories/x-libs/local_daemon";
import { register_call_table } from "@x-tech-laboratories/x-libs/server/call_table";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";

import { create_daemon_router, type DaemonRouter } from "../src/main/daemon_router.ts";
import { build_app } from "../src/server/app.ts";
import { register_dev_calls } from "../src/server/calls.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import { read_desktop_settings, type DaemonMethods, type DesktopSettings } from "../src/shared/desktop.ts";
import { insert_run, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, is_read_only, open_store } from "../src/shared/store.ts";
import { memory_connection_storage, temp_folder } from "./helpers/loopback.ts";

const password = "a long enough password";
const servers: FastifyInstance[] = [];
let router: DaemonRouter | null = null;

afterEach(async () => {
  router?.stop();
  router = null;
  for (const server of servers.splice(0)) await server.close();
});

// ============================================================================
// Daemons
// ============================================================================

// This computer's daemon as the window reaches it: the data calls, its own settings and its event stream on a socket.
async function local_daemon() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const changes = new EventStream();
  let settings: DesktopSettings = read_desktop_settings(null);
  const daemon_methods: DaemonMethods = {
    get_desktop_settings: () => settings,
    set_desktop_setting: (key, value) => void (settings = { ...settings, [key]: value }),
    stop_daemon: () => undefined,
  };
  const socket_path = join(temp_folder("socket"), "daemon.sock");
  const listen = async (): Promise<FastifyInstance> => {
    const server = fastify({ forceCloseConnections: true });
    await server.register(
      async (api) => {
        changes.register(api, "/events");
        register_dev_calls(api, () => database, changes);
        register_call_table(api, "/daemon", daemon_methods, { is_read_only });
      },
      { prefix: "/api" },
    );
    await server.listen({ path: socket_path });
    servers.push(server);
    return server;
  };
  const server = await listen();
  return { database, changes, socket_path, server, listen, store: bind_methods(() => database, () => changes.announce_change()) };
}

// A daemon on another computer that lets other devices connect, on a loopback port with one admin.
async function remote_daemon() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const changes = new EventStream();
  const stages = create_stage_files({ folder: temp_folder("stages") }).methods;
  stages.add_default_stages();
  const backups = { list_backups: async () => [], create_backup: async () => ({}), restore_backup: async () => undefined, remove_backup: async () => undefined, get_backup_schedule: () => ({}), set_backup_schedule: () => undefined } as never;
  const server = await build_app({ database, declared: new Map([["root", hash_password(password)]]), web_folder: "/nonexistent", backups, stages, changes });
  await server.listen({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  const address = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  return { database, address, store: bind_methods(() => database, () => changes.announce_change()) };
}

async function setup() {
  const here = await local_daemon();
  const elsewhere = await remote_daemon();
  const connections = create_connections({ storage: memory_connection_storage(), offers_local: true, device_name: "Test laptop" });
  const link = create_daemon_link({ connections, socket_path: here.socket_path });
  const events = { on_change: vi.fn(), on_sync_status: vi.fn(), on_switch: vi.fn(), after_write: vi.fn(), show_notice: vi.fn() };
  const restart_local = vi.fn(async () => here.listen());
  router = create_daemon_router({ connections, link, call_local: (path, args, headers) => call_daemon(here.socket_path, path, args, headers), restart_local, ...events });
  const go_elsewhere = async (): Promise<string> => {
    const view = await connections.methods.add_connection(elsewhere.address, { name: "root", password }, "Workstation");
    const id = view.connections.find((connection) => connection.kind === "remote")!.id;
    await connections.methods.choose_connection(id);
    return id;
  };
  return { here, elsewhere, connections, router, events, restart_local, go_elsewhere };
}

// ============================================================================
// Calls
// ============================================================================

describe("the desktop app's choice of daemon", () => {
  it("sends the page's calls to this computer's daemon until another is chosen", async () => {
    const { here, elsewhere, router, events, go_elsewhere } = await setup();

    const local_id = (await router.call("call/save_item", [{ title: "Made here", repository: "owner/repo" }])) as string;
    expect(router.is_here()).toBe(true);
    expect(here.store.get_item(local_id).title).toBe("Made here");
    expect(events.after_write).toHaveBeenCalledTimes(1);

    await go_elsewhere();

    expect(router.is_here()).toBe(false);
    expect(events.on_switch).toHaveBeenCalledTimes(1);
    await router.call("call/save_item", [{ title: "Made elsewhere", repository: "owner/repo" }]);
    expect(elsewhere.store.list_items().map((item) => item.title)).toEqual(["Made elsewhere"]);
    expect(((await router.call("call/list_items", [false])) as { title: string }[]).map((item) => item.title)).toEqual(["Made elsewhere"]);
    expect(here.store.list_items().map((item) => item.title)).toEqual(["Made here"]);
    expect(events.after_write).toHaveBeenCalledTimes(2);
  });

  it("keeps this computer's own settings on its daemon whichever daemon is chosen", async () => {
    const { router, go_elsewhere } = await setup();
    await go_elsewhere();

    await router.call("daemon/set_desktop_setting", ["notify_run_failed", false]);

    expect((await router.get_desktop_settings()).notify_run_failed).toBe(false);
  });

  it("names each table's calls under its own path, worked out when called", async () => {
    const { router, go_elsewhere } = await setup();
    const forwarded = router.forwarded(["list_items"], () => "call");

    expect(await forwarded.list_items!(false)).toEqual([]);
    await go_elsewhere();
    await expect(router.forwarded(["get_desktop_settings"], "daemon").get_desktop_settings!()).resolves.toMatchObject({ show_tray_icon: true });
  });
});

// ============================================================================
// Change events
// ============================================================================

describe("following the chosen daemon's changes", () => {
  it("tells the windows of changes on this computer, then on the daemon chosen elsewhere", async () => {
    const { here, elsewhere, router, events, go_elsewhere } = await setup();
    router.start();
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());
    events.on_change.mockClear();

    here.store.save_item({ title: "Changed here", repository: "owner/repo" });
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());

    await go_elsewhere();
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());
    events.on_change.mockClear();
    elsewhere.store.save_item({ title: "Changed elsewhere", repository: "owner/repo" });
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());

    // This computer's changes no longer reach a window looking elsewhere.
    events.on_change.mockClear();
    here.store.save_item({ title: "Changed here again", repository: "owner/repo" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events.on_change).not.toHaveBeenCalled();
  });

  it("is not told of its own changes on a daemon elsewhere, as the daemon knows it by the id it gave", async () => {
    const { router, events, go_elsewhere } = await setup();
    router.start();
    await go_elsewhere();
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    events.on_change.mockClear();

    await router.call("call/save_item", [{ title: "Made by this window", repository: "owner/repo" }]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(events.on_change).not.toHaveBeenCalled();
  });

  it("starts this computer's daemon again when it goes away, but not once the app is quitting", async () => {
    const { here, router, events, restart_local } = await setup();
    router.start();
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());

    await here.server.close();
    await vi.waitFor(() => expect(restart_local).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalledTimes(2), { timeout: 3000 });

    router.quitting();
    const restarted = (await restart_local.mock.results[0]!.value) as FastifyInstance;
    await restarted.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(restart_local).toHaveBeenCalledTimes(1);
  });

  it("leaves a daemon elsewhere that went away to come back by itself", async () => {
    const { router, events, restart_local, go_elsewhere } = await setup();
    router.start();
    await go_elsewhere();
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());

    await servers[1]!.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(restart_local).not.toHaveBeenCalled();
  });

  it("passes sync's status on to the windows", async () => {
    const { here, router, events } = await setup();
    router.start();
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());

    here.changes.send(JSON.stringify({ state: "syncing" }), { event: "sync_status" });

    await vi.waitFor(() => expect(events.on_sync_status).toHaveBeenCalledWith({ state: "syncing" }));
  });
});

// ============================================================================
// Notices from elsewhere
// ============================================================================

describe("notices for a daemon elsewhere", () => {
  function start_run(database: DatabaseSync, item_id: string): string {
    return insert_run(database, { item_id, stage: "plan", model: "fable", effort: "high", session_id: "session", start_commit: "abc", status_before: "{}", input: "Plan it.", started_at: "2026-11-20T10:00:00Z" });
  }

  it("shows what the runs there did, by the kinds switched on on this computer", async () => {
    const { elsewhere, router, events, go_elsewhere } = await setup();
    const item_id = elsewhere.store.save_item({ title: "Board with swimlanes", repository: "owner/repo", stage: "plan" });
    const asking = start_run(elsewhere.database, item_id);
    router.start();
    await go_elsewhere();
    await router.check_notices();

    update_run(elsewhere.database, asking, { state: "waiting", questions: [{ question: "Lanes or tabs?", why: "Both fit.", choices: [] }] });
    await router.check_notices();

    expect(events.show_notice).toHaveBeenCalledTimes(1);
    expect(events.show_notice).toHaveBeenCalledWith(expect.objectContaining({ kind: "run_asked", title: "Plan has questions: Board with swimlanes", body: "Lanes or tabs?", key: `item-${item_id}` }));

    // Failures are switched off on this computer, though the daemon elsewhere would show them.
    await router.call("daemon/set_desktop_setting", ["notify_run_failed", false]);
    const failing = start_run(elsewhere.database, elsewhere.store.save_item({ title: "Another", repository: "owner/repo", stage: "plan" }));
    await router.check_notices();
    update_run(elsewhere.database, failing, { state: "failed", error: "It broke." });
    await router.check_notices();

    expect(events.show_notice).toHaveBeenCalledTimes(1);
  });

  it("hears of a run's end through the daemon's change events", async () => {
    const { elsewhere, router, events, go_elsewhere } = await setup();
    const item_id = elsewhere.store.save_item({ title: "Board with swimlanes", repository: "owner/repo", stage: "plan" });
    const run_id = start_run(elsewhere.database, item_id);
    router.start();
    await go_elsewhere();
    await vi.waitFor(() => expect(events.on_change).toHaveBeenCalled());
    await router.check_notices();

    update_run(elsewhere.database, run_id, { state: "done", report: "## Plan handoff\n**Next:** specify\n**Done:**\n- Planned lanes." });
    elsewhere.store.save_item_notes(item_id, "Seen.");

    await vi.waitFor(() => expect(events.show_notice).toHaveBeenCalledWith(expect.objectContaining({ kind: "run_finished", title: "Plan finished: Board with swimlanes" })));
  });

  it("leaves this computer's runs to its daemon, which shows them itself", async () => {
    const { here, router, events, go_elsewhere, connections } = await setup();
    const run_id = start_run(here.database, here.store.save_item({ title: "Here", repository: "owner/repo", stage: "plan" }));
    router.start();
    await router.check_notices();

    update_run(here.database, run_id, { state: "failed", error: "It broke." });
    await router.check_notices();

    await go_elsewhere();
    await connections.methods.choose_connection("local");
    await router.check_notices();
    expect(router.is_here()).toBe(true);
    expect(events.show_notice).not.toHaveBeenCalled();
  });
});
