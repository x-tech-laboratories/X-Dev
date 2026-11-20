// Sync between daemons and a server over real listeners on loopback ports, each on a throwaway database.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";
import { create_sync_client, type SyncClient, type SyncConfig } from "@x-tech-laboratories/x-libs/sync_client";

import { build_app } from "../src/server/app.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import { insert_run, propose, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, open_store, sync_engine } from "../src/shared/store.ts";
import { admin, repository, start_test_daemon, type TestDaemon } from "./helpers/daemon.ts";
import { temp_folder } from "./helpers/loopback.ts";

const clients: SyncClient[] = [];
const daemons: TestDaemon[] = [];
const servers: FastifyInstance[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) await server.close();
});

// ============================================================================
// Hosts
// ============================================================================

// The web server, which every daemon's data syncs through, with one admin.
async function start_server() {
  const database = new DatabaseSync(join(temp_folder("server"), "server.db"));
  open_store(database);
  const stages = create_stage_files({ folder: temp_folder("stages") }).methods;
  const backups = { list_backups: async () => [], create_backup: async () => ({}), restore_backup: async () => undefined, remove_backup: async () => undefined, get_backup_schedule: () => ({}), set_backup_schedule: () => undefined } as never;
  const server = await build_app({ database, declared: new Map([[admin.name, hash_password(admin.password)]]), web_folder: "/nonexistent", backups, stages });
  await server.listen({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  return { database, store: bind_methods(() => database, () => undefined), address: `http://127.0.0.1:${(server.server.address() as { port: number }).port}` };
}

async function start_daemon(): Promise<TestDaemon> {
  const daemon = await start_test_daemon();
  daemons.push(daemon);
  return daemon;
}

// A sync client as the daemon runs one, its sign-in kept in memory, syncing only when asked.
function sync_client_of(database: DatabaseSync, on_remote_change: () => void = () => undefined): SyncClient {
  let config: SyncConfig | null = null;
  const client = create_sync_client({
    engine: sync_engine,
    database: () => database,
    storage: {
      read_config: () => config,
      write_config: (next) => void (config = next),
      remove_config: () => void (config = null),
      back_up_before_download: () => undefined,
    },
    device_name: "Test daemon",
    on_remote_change,
    local_check_ms: 60_000,
    full_sync_ms: 60_000,
  });
  clients.push(client);
  return client;
}

// Syncs each client in turn, twice over, so a change made anywhere has been through the server to everyone.
async function sync_all(...all: SyncClient[]): Promise<void> {
  for (let round = 0; round < 2; round++) for (const client of all) expect((await client.sync_now()).state).toBe("idle");
}

function start_run_row(database: DatabaseSync, item_id: string): string {
  return insert_run(database, { item_id, stage: "plan", model: "fable", effort: "high", session_id: "session", start_commit: "abc", status_before: "{}", input: "Plan it.", started_at: "2026-11-20T10:00:00Z" });
}

// ============================================================================
// Through a server
// ============================================================================

describe("two daemons syncing through the server", () => {
  it("converge on items, runs with their questions, answers and reports, and proposals changed on each side", async () => {
    const server = await start_server();
    const first = await start_daemon();
    const second = await start_daemon();
    const first_sync = sync_client_of(first.database);
    const second_sync = sync_client_of(second.database);
    const id = first.store.save_item({ title: "Board with swimlanes", repository, stage: "plan" });
    const run_id = start_run_row(first.database, id);
    update_run(first.database, run_id, { state: "waiting", questions: [{ question: "Lanes or tabs?", why: "Both fit.", choices: ["Lanes", "Tabs"] }] });
    propose(first.database, { item_id: id, run_id }, { title: "Keyboard moves between lanes", why: "Seen while planning." }, "2026-11-20T10:05:00Z");

    await first_sync.connect(server.address, admin, "upload");
    await second_sync.connect(server.address, admin, "download");
    expect(second.store.get_item(id).title).toBe("Board with swimlanes");

    // Each side changes something while the other finishes the run.
    second.store.save_item_notes(id, "Use lanes.");
    const second_item = second.store.save_item({ title: "Faster board drawing", repository });
    update_run(first.database, run_id, { state: "done", report: "## Plan handoff\n**Next:** specify\n**Done:**\n- Planned lanes.", answers: "Lanes" });
    await sync_all(first_sync, second_sync);

    for (const copy of [first.store, second.store, server.store]) {
      expect(copy.get_run(run_id)).toMatchObject({ state: "done", answers: "Lanes", questions: [{ question: "Lanes or tabs?" }] });
      expect(copy.get_item(id).notes).toBe("Use lanes.");
      expect(copy.get_item(second_item).title).toBe("Faster board drawing");
      expect(copy.list_proposals().map((proposal) => proposal.title)).toEqual(["Keyboard moves between lanes"]);
    }
    expect(second.store.list_stage_runs()).toEqual(first.store.list_stage_runs());
  });

  it("leaves a run another daemon started to it: not failed at start, answered or discarded here", async () => {
    const server = await start_server();
    const first = await start_daemon();
    const second = await start_daemon();
    const first_sync = sync_client_of(first.database);
    const second_sync = sync_client_of(second.database);
    await first_sync.connect(server.address, admin, "upload");
    await second_sync.connect(server.address, admin, "download");

    // The first daemon runs a stage that asks, then starts one that is still under way.
    const asking_item = first.store.save_item({ title: "Board with swimlanes", repository, body: "ASK STATUS", stage: "plan", issue_number: 7 });
    const asking = await first.runner.methods.start_run(asking_item, {});
    await first.runner.idle();
    const running = await first.runner.methods.start_run(first.store.save_item({ title: "Faster board drawing", repository, body: "SLOW", stage: "plan", issue_number: 8 }), {});
    await sync_all(first_sync, second_sync);
    expect(second.store.get_run(asking).state).toBe("waiting");
    expect(second.store.get_run(running).state).toBe("running");

    second.runner.recover();

    expect(second.store.get_run(running).state).toBe("running");
    expect(() => second.runner.methods.answer_run(asking, "Lanes.")).toThrow("that run was started on another computer");
    await expect(second.runner.methods.discard_run(asking)).rejects.toThrow("that run was started on another computer");
    expect(second.store.get_run(asking).state).toBe("waiting");

    // The daemon that started it still answers it, and the answer reaches the other.
    first.runner.stop_current();
    await first.runner.idle();
    first.runner.methods.answer_run(asking, "Lanes.");
    await first.runner.idle();
    await sync_all(first_sync, second_sync);
    expect(second.store.get_run(asking)).toMatchObject({ state: "done", answers: "Lanes." });
    expect(second.store.get_run(running).state).toBe("stopped");
  });
});

// ============================================================================
// A daemon in between
// ============================================================================

describe("a daemon that serves sync to another and syncs with the server", () => {
  async function chain() {
    const server = await start_server();
    const middle = await start_daemon();
    const middle_sync = sync_client_of(middle.database);
    await middle_sync.connect(server.address, admin, "upload");
    const far_database = new DatabaseSync(":memory:");
    open_store(far_database);
    const far = bind_methods(() => far_database, () => undefined);
    const far_sync = sync_client_of(far_database);
    await far_sync.connect(middle.address, admin, "download");
    return { server, middle, middle_sync, far, far_sync };
  }

  it("passes the server's changes on to the device syncing with it", async () => {
    const { server, middle, middle_sync, far, far_sync } = await chain();

    const id = server.store.save_item({ title: "Made on the server", repository });
    await middle_sync.sync_now();
    await far_sync.sync_now();

    expect(middle.store.get_item(id).title).toBe("Made on the server");
    expect(far.get_item(id).title).toBe("Made on the server");
  });

  it("takes the device's changes itself", async () => {
    const { middle, far, far_sync } = await chain();

    const id = far.save_item({ title: "Made on the far device", repository });
    await far_sync.sync_now();

    expect(middle.store.get_item(id).title).toBe("Made on the far device");
  });

  // Fails: a daemon sends the server only the changes made on it, never those it took from a device syncing with it.
  it.fails("passes the device's changes on to the server", async () => {
    const { server, middle_sync, far, far_sync } = await chain();

    const id = far.save_item({ title: "Made on the far device", repository });
    await far_sync.sync_now();
    await middle_sync.sync_now();

    expect(server.store.list_items().map((item) => item.id)).toContain(id);
  });
});
