// Sync between daemons and a server, each a paired peer on a throwaway database, their calls carried by an in-memory network.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { create_sync_peer, type SyncPeer } from "@x-tech-laboratories/x-libs/sync_peer";
import { peer_device_header, peer_key_header, type PeerIdentity, type PeerRecord, type PeerStorage } from "@x-tech-laboratories/x-libs/sync_protocol";

import { insert_run, propose, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, open_store, sync_engine } from "../src/shared/store.ts";
import { repository, start_test_daemon, type TestDaemon } from "./helpers/daemon.ts";
import { temp_folder } from "./helpers/loopback.ts";

const peers: SyncPeer[] = [];
const daemons: TestDaemon[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.stop();
  for (const daemon of daemons.splice(0)) await daemon.stop();
});

// ============================================================================
// Hosts
// ============================================================================

// Delivers each call to the peer answering at the address's origin, as the network would.
const network = new Map<string, SyncPeer>();
const network_fetch: typeof fetch = async (input, init) => {
  const peer = network.get(new URL(String(input)).origin);
  if (!peer) throw new TypeError("fetch failed");
  const headers = init?.headers as Record<string, string>;
  const reply = await peer.answer({ device: headers[peer_device_header]!, key: headers[peer_key_header], body: new Uint8Array(init!.body as Uint8Array) });
  return new Response(reply.body as BodyInit, { status: reply.status });
};

function memory_storage(): PeerStorage {
  let identity: PeerIdentity | null = null;
  let saved: PeerRecord[] = [];
  return {
    read_identity: () => identity,
    write_identity: (written) => void (identity = written),
    read_peers: () => saved,
    write_peers: (written) => void (saved = written),
    back_up_before_replace: () => undefined,
  };
}

// A sync peer as a daemon or the server runs one, syncing only when asked; one with an address answers the others there.
function peer_of(database: DatabaseSync, name: string, address: string | null = null, unreachable = ""): SyncPeer {
  const reach: typeof fetch = (input, init) => (unreachable && String(input).startsWith(unreachable) ? Promise.reject(new TypeError("fetch failed")) : network_fetch(input, init));
  const peer = create_sync_peer({
    app: "x-dev",
    engine: sync_engine,
    database: () => database,
    storage: memory_storage(),
    device_name: name,
    addresses: () => (address ? [address] : []),
    fetch: reach,
  });
  if (address) network.set(new URL(address).origin, peer);
  peers.push(peer);
  return peer;
}

let server_count = 0;

// The server, one of the peers, which every daemon reaches.
function start_server() {
  const database = new DatabaseSync(join(temp_folder("server"), "server.db"));
  open_store(database);
  server_count += 1;
  const peer = peer_of(database, "X-Dev server", `http://server-${server_count}.test/api/`);
  return { database, store: bind_methods(() => database, () => undefined), peer };
}

async function start_daemon(): Promise<TestDaemon> {
  const daemon = await start_test_daemon();
  daemons.push(daemon);
  return daemon;
}

// Syncs each peer in turn, twice over, so a change made anywhere has reached everyone.
async function sync_all(...all: SyncPeer[]): Promise<void> {
  for (let round = 0; round < 2; round++) for (const peer of all) expect((await peer.sync_now()).state).toBe("idle");
}

function start_run_row(database: DatabaseSync, item_id: string): string {
  return insert_run(database, { item_id, stage: "plan", model: "fable", effort: "high", session_id: "session", start_commit: "abc", status_before: "{}", input: "Plan it.", started_at: "2026-11-20T10:00:00Z" });
}

// ============================================================================
// Through a server
// ============================================================================

describe("two daemons paired with the server", () => {
  it("converge on items, runs with their questions, answers and reports, and proposals changed on each side", async () => {
    const server = start_server();
    const first = await start_daemon();
    const second = await start_daemon();
    const first_sync = peer_of(first.database, "First daemon");
    const second_sync = peer_of(second.database, "Second daemon");
    const id = first.store.save_item({ title: "Board with swimlanes", repository, stage: "plan" });
    const run_id = start_run_row(first.database, id);
    update_run(first.database, run_id, { state: "waiting", questions: [{ question: "Lanes or tabs?", why: "Both fit.", choices: ["Lanes", "Tabs"] }] });
    propose(first.database, { item_id: id, run_id }, { title: "Keyboard moves between lanes", why: "Seen while planning." }, "2026-11-20T10:05:00Z");

    await first_sync.pair_device(server.peer.create_pairing_code().code);
    await second_sync.pair_device(server.peer.create_pairing_code().code);
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
    const server = start_server();
    const first = await start_daemon();
    const second = await start_daemon();
    const first_sync = peer_of(first.database, "First daemon");
    const second_sync = peer_of(second.database, "Second daemon");
    await first_sync.pair_device(server.peer.create_pairing_code().code);
    await second_sync.pair_device(server.peer.create_pairing_code().code);

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
  }, 15_000);
});

// ============================================================================
// A daemon in between
// ============================================================================

describe("a daemon that lets another connect and is paired with the server", () => {
  let chain_count = 0;

  // The far device reaches only the daemon in the middle, which reaches only the server.
  async function chain() {
    const server = start_server();
    const middle = await start_daemon();
    chain_count += 1;
    const middle_sync = peer_of(middle.database, "Middle daemon", `http://middle-${chain_count}.test/`);
    await middle_sync.pair_device(server.peer.create_pairing_code().code);
    const far_database = new DatabaseSync(":memory:");
    open_store(far_database);
    const far = bind_methods(() => far_database, () => undefined);
    const far_sync = peer_of(far_database, "Far device", null, `http://server-${server_count}.test/`);
    await far_sync.pair_device(middle_sync.create_pairing_code().code);
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

  it("passes the device's changes on to the server", async () => {
    const { server, middle_sync, far, far_sync } = await chain();

    const id = far.save_item({ title: "Made on the far device", repository });
    await far_sync.sync_now();
    await middle_sync.sync_now();

    expect(server.store.list_items().map((item) => item.id)).toContain(id);
  });
});
