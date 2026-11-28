import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";

import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";
import { file_sync_storage } from "@x-tech-laboratories/x-libs/sync_file_storage";
import { decode_pairing_offer } from "@x-tech-laboratories/x-libs/sync_seal";

import { build_app } from "../src/server/app.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import { stages_method_names } from "../src/shared/stages/model.ts";
import { method_names, open_store } from "../src/shared/store.ts";

let app: FastifyInstance;
// The token every request but the sign-in tests carries.
let token = "";
const password = "a long enough password";

afterEach(async () => {
  await app?.close();
});

// Sends one MCP request as a client speaking the 2025 protocol would, and gives back its result.
async function mcp(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  const reply = await signed({
    method: "POST",
    url: "/api/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = /^data: (.+)$/m.exec(reply.body)?.[1] ?? reply.body;
  return (JSON.parse(data) as { result: Record<string, unknown> }).result;
}

const taken = { name: "dev-2026-11-10T09-30-00Z.db", taken_at: "2026-11-10T09:30:00Z", is_automatic: false, size_bytes: 4096 };
const fake_backups = {
  list_backups: vi.fn(async () => [taken]),
  create_backup: vi.fn(async () => taken),
  restore_backup: vi.fn(async () => undefined),
  remove_backup: vi.fn(async () => undefined),
  get_backup_schedule: vi.fn(() => ({ automatic: true, to_keep: 14 })),
  set_backup_schedule: vi.fn(),
};

async function start(web_folder = "/nonexistent"): Promise<FastifyInstance> {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  const sync = { storage: file_sync_storage({ file: join(mkdtempSync(join(tmpdir(), "x-dev-sync-")), "sync-peers.json"), back_up_before_replace: () => {} }), address: "https://dev.example.org/api/" };
  app = await build_app({ database, declared: new Map([["root", hash_password(password)]]), web_folder, backups: fake_backups, stages, sync });
  token = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password, device: "tests" } })).json().token;
  return app;
}

// A request as the signed-in tests device.
function signed(options: InjectOptions) {
  return app.inject({ ...options, headers: { ...options.headers, authorization: `Bearer ${token}` } });
}

describe("server", () => {
  it("refuses API calls until signed in, but serves the page", async () => {
    await start();
    expect((await app.inject({ method: "POST", url: "/api/call/get_settings", payload: [] })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/mcp", payload: {} })).statusCode).toBe(401);
    expect((await signed({ method: "POST", url: "/api/call/get_settings", payload: [] })).statusCode).toBe(200);
  });

  it("refuses an encoded path to an API call before sign-in", async () => {
    await start();
    expect([400, 401]).toContain((await app.inject({ method: "POST", url: "/%61pi/call/get_settings", payload: [] })).statusCode);
  });

  it("serves the built page beside the API", async () => {
    const folder = mkdtempSync(join(tmpdir(), "x-dev-web-"));
    writeFileSync(join(folder, "index.html"), "<title>X-Dev</title>");
    await start(folder);
    expect((await signed({ method: "GET", url: "/" })).body).toContain("X-Dev");
    expect((await signed({ method: "GET", url: "/api/missing" })).statusCode).toBe(404);
  });

  it("answers the page's calls by name with JSON arguments", async () => {
    await start();
    const write = await signed({ method: "POST", url: "/api/call/set_setting", payload: ["history.keep_days", 30] });
    expect(write.statusCode).toBe(204);
    const read = await signed({ method: "POST", url: "/api/call/get_settings", payload: [] });
    expect(read.json()).toMatchObject({ "history.keep_days": 30 });
  });

  it("takes a call whose argument is a large import file", async () => {
    await start();
    const big = JSON.stringify({ log: "x".repeat(3 * 1024 * 1024) });
    const reply = await signed({ method: "POST", url: "/api/call/set_setting", payload: ["import.test", big] });
    expect(reply.statusCode).toBe(204);
  });

  it("takes the arguments by name as a JSON object too", async () => {
    await start();
    const write = await signed({ method: "POST", url: "/api/call/set_setting", payload: { value: 90, key: "history.keep_days" } });
    expect(write.statusCode).toBe(204);
    expect((await signed({ method: "POST", url: "/api/call/get_settings", payload: {} })).json()).toMatchObject({ "history.keep_days": 90 });
  });

  it("refuses arguments it cannot place and calls it does not know", async () => {
    await start();
    const unknown_name = await signed({ method: "POST", url: "/api/call/get_settings", payload: { not: "an argument" } });
    expect(unknown_name.statusCode).toBe(400);
    expect(unknown_name.body).toBe("unknown argument not");
    expect((await signed({ method: "POST", url: "/api/call/set_setting", payload: { key: "history.keep_days" } })).statusCode).toBe(400);
    expect((await signed({ method: "POST", url: "/api/call/drop_everything", payload: [] })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("describes every call in an OpenAPI document", async () => {
    await start();
    const document = (await signed({ method: "GET", url: "/api/openapi.json" })).json() as { paths: Record<string, { post: { operationId: string; tags: string[] } }> };
    expect(document.paths["/api/call/get_item"]!.post).toMatchObject({ operationId: "get_item", tags: ["read"] });
    expect(document.paths["/api/call/save_item"]!.post.tags).toEqual(["change"]);
    expect(Object.keys(document.paths)).toHaveLength(method_names.length + stages_method_names.length);
  });

  it("serves every call as an MCP tool", async () => {
    await start();
    const listed = await mcp("tools/list");
    const tools = listed.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([...method_names, ...stages_method_names].sort());
    expect(tools.find((tool) => tool.name === "list_items")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "save_item")!.annotations.readOnlyHint).toBe(false);

    const saved = await mcp("tools/call", { name: "save_item", arguments: { item: { title: "Board", repository: "x-tech-laboratories/X-Dev" } } });
    const item_id = (saved.content as { text: string }[])[0]!.text;
    await mcp("tools/call", { name: "update_item_status", arguments: { id: item_id, changes: { goal: "Swimlanes." } } });
    const item = await mcp("tools/call", { name: "get_item", arguments: { id: item_id } });
    expect(JSON.parse((item.content as { text: string }[])[0]!.text)).toMatchObject({ title: "Board", status: { goal: "Swimlanes." } });
  });

  it("lets paired devices reach its sync without signing in, and gives only an admin a pairing code", async () => {
    await start();
    const stranger = await app.inject({ method: "POST", url: "/api/sync/peer", headers: { "content-type": "application/octet-stream", "x-sync-device": "NOBODY" }, payload: Buffer.alloc(64) });
    expect(stranger.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/sync_device/create_pairing_code", payload: [] })).statusCode).toBe(401);

    const made = await signed({ method: "POST", url: "/api/sync_device/create_pairing_code", payload: [] });
    const offer = decode_pairing_offer((made.json() as { code: string }).code);
    expect(offer).toMatchObject({ app: "x-dev", name: "X-Dev server", addresses: ["https://dev.example.org/api/"] });
  });

  it("lets an admin list and take the server's backups, and refuses unknown backup calls", async () => {
    await start();

    expect((await app.inject({ method: "POST", url: "/api/backup/list_backups", payload: [] })).statusCode).toBe(401);
    const listed = await signed({ method: "POST", url: "/api/backup/list_backups", payload: [] });
    expect(listed.json()).toEqual([taken]);
    expect((await signed({ method: "POST", url: "/api/backup/create_backup", payload: [] })).json()).toEqual(taken);
    expect(fake_backups.create_backup).toHaveBeenCalled();
    expect((await signed({ method: "POST", url: "/api/backup/drop_everything", payload: [] })).statusCode).toBe(404);
  });

  it("lets an admin read and add the stage files", async () => {
    await start();

    expect((await app.inject({ method: "POST", url: "/api/stages/list_stages", payload: [] })).statusCode).toBe(401);
    expect((await signed({ method: "POST", url: "/api/stages/add_default_stages", payload: [] })).json()).toBeGreaterThan(0);
    const listed = (await signed({ method: "POST", url: "/api/stages/list_stages", payload: [] })).json() as { stages: { id: string }[] };
    expect(listed.stages[0]!.id).toBe("triage");
  });
});
