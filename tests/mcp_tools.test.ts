import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { create_local_mcp, type LocalMcp } from "@x-tech-laboratories/x-libs/electron/mcp";
import { local_mcp_client_config } from "@x-tech-laboratories/x-libs/local_mcp_protocol";
import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";

import { build_app } from "../src/server/app.ts";
import { create_mcp_call, mcp_api } from "../src/server/mcp_calls.ts";
import { create_run_tools, type RunTools } from "../src/server/run_tools.ts";
import { create_runner, type Runner } from "../src/server/runner.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import { mcp_instructions } from "../src/shared/mcp.ts";
import { runner_api } from "../src/shared/runs/api.ts";
import { stages_api } from "../src/shared/stages/api.ts";
import { bind_methods, dev_api, is_read_only, open_store } from "../src/shared/store.ts";

const fake_claude = join(import.meta.dirname, "fixtures", "fake_claude.mjs");
const fake_gh = join(import.meta.dirname, "fixtures", "fake_gh.mjs");
const password = "a long enough password";

let app: FastifyInstance | null = null;
let local: LocalMcp | null = null;
let runner: Runner | null = null;
let run_tools: RunTools | null = null;

afterEach(async () => {
  await app?.close();
  await local?.stop();
  runner?.stop_current();
  await runner?.idle();
  await run_tools?.stop();
  app = local = runner = run_tools = null;
});

// A throwaway checkout whose origin names x-tech-laboratories/X-Dev, standing in for the user's own.
function make_checkout(): string {
  const folder = mkdtempSync(join(tmpdir(), "x-dev-checkout-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "git@github.com:x-tech-laboratories/X-Dev.git");
  writeFileSync(join(folder, "README.md"), "# Test\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-q", "-m", "chore: start");
  return folder;
}

// The daemon's parts with stand-ins for claude and gh, so nothing reaches Claude or GitHub.
async function daemon_parts() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  stages.add_default_stages();
  run_tools = create_run_tools({ database: () => database, after_write: () => undefined, on_asked: (run_id) => runner!.mark_asked(run_id) });
  await run_tools.start();
  runner = create_runner({ database: () => database, stages, run_tools, folder: mkdtempSync(join(tmpdir(), "x-dev-runner-")), after_write: () => undefined });
  runner.methods.set_runner_setting("claude_program", fake_claude);
  runner.methods.set_runner_setting("gh_program", fake_gh);
  return { database, stages, runner };
}

// One MCP request as a client speaking the 2025 protocol sends it, giving back its result.
async function mcp(url: string, headers: Record<string, string>, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const data = /^data: (.+)$/m.exec(text)?.[1] ?? text;
  return (JSON.parse(data) as { result: Record<string, unknown> }).result;
}

// A tool's answer as the JSON it holds, or its error text.
function answer(result: Record<string, unknown>): { error: boolean; value: unknown } {
  const text = (result.content as { text: string }[])[0]!.text;
  try {
    return { error: result.isError === true, value: JSON.parse(text) };
  } catch {
    return { error: result.isError === true, value: text };
  }
}

async function server_endpoint() {
  const parts = await daemon_parts();
  const backups = { list_backups: async () => [], create_backup: async () => ({}), restore_backup: async () => undefined, remove_backup: async () => undefined, get_backup_schedule: () => ({}), set_backup_schedule: () => undefined } as never;
  app = await build_app({ database: parts.database, declared: new Map([["root", hash_password(password)]]), web_folder: "/nonexistent", backups, stages: parts.stages, runner: parts.runner.methods });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const sign_in = async (name: string) => ((await (await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password, device: "a session" }) })).json()) as { token: string }).token;
  const session = (await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "root", password }) })).headers.get("set-cookie")!.split(";")[0]!;
  await fetch(`${base}/api/users`, { method: "POST", headers: { "content-type": "application/json", cookie: session }, body: JSON.stringify({ name: "guest", password, role: "user" }) });
  const read_only = ((await (await fetch(`${base}/api/account/tokens`, { method: "POST", headers: { "content-type": "application/json", cookie: session }, body: JSON.stringify({ name: "reader", read_only: true }) })).json()) as { token: string }).token;
  const adder = ((await (await fetch(`${base}/api/account/tokens`, { method: "POST", headers: { "content-type": "application/json", cookie: session }, body: JSON.stringify({ name: "filer", scope: "add_items" }) })).json()) as { token: string }).token;
  const as = (token: string) => (method: string, params?: unknown) => mcp(`${base}/api/mcp`, { authorization: `Bearer ${token}` }, method, params);
  // One API call with a token, giving back the status and the answer.
  const post = async (token: string, path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  return {
    ...parts,
    session,
    base,
    tokens: { reader: read_only, adder },
    post,
    admin: as(await sign_in("root")),
    user: as(await sign_in("guest")),
    reader: as(read_only),
    adder: as(adder),
    anyone: async () => (await fetch(`${base}/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
  };
}

describe("the server's MCP endpoint", () => {
  it("offers every control, the reads marked read-only and the ones that act on the host saying so", async () => {
    const { admin } = await server_endpoint();

    const tools = (await admin("tools/list")).tools as { name: string; description: string; annotations: { readOnlyHint: boolean } }[];
    const by_name = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [...Object.keys(dev_api), ...Object.keys(stages_api), ...Object.keys(runner_api)]) expect(by_name.has(name), name).toBe(true);
    for (const name of ["list_items", "get_run", "list_proposals", "list_run_summaries", "get_changes", "get_file_change", "list_stages", "get_stage", "get_runner"]) expect(by_name.get(name)!.annotations.readOnlyHint, name).toBe(true);
    for (const name of ["add_item", "start_run", "answer_run", "discard_run", "save_stage", "add_repository", "override_gate", "send_item_back"]) expect(by_name.get(name)!.annotations.readOnlyHint, name).toBe(false);
    for (const name of ["start_run", "answer_run"]) expect(by_name.get(name)!.description).toContain("starts an AI coding agent");
    expect(by_name.get("discard_run")!.description).toContain("with its user's rights");
  });

  it("adds an item from a checkout's folder as the form does, opening its issue, then runs it and answers its question", async () => {
    const { admin, database } = await server_endpoint();
    const checkout = make_checkout();

    const added = answer(await admin("tools/call", { name: "add_item", arguments: { input: { title: "Swimlanes on the board", repository: checkout, body: "One lane per repository. ASK STATUS" } } }));
    expect(added).toMatchObject({ error: false, value: { repository: "x-tech-laboratories/X-Dev", issue: { number: 42, opened: true }, checkout_added: true, problem: "" } });
    const id = (added.value as { id: string }).id;
    const store = bind_methods(() => database, () => undefined);
    expect(store.get_item(id)).toMatchObject({ title: "Swimlanes on the board", repository: "x-tech-laboratories/X-Dev", issue_number: 42, stage: "triage" });

    const run_id = answer(await admin("tools/call", { name: "start_run", arguments: { item_id: id, options: { stage: "plan" } } })).value as string;
    await runner!.idle();
    expect(store.get_run(run_id).state).toBe("waiting");
    expect(answer(await admin("tools/call", { name: "get_run", arguments: { id: run_id } })).value).toMatchObject({ questions: [{ question: "Which board layout?" }] });

    await admin("tools/call", { name: "answer_run", arguments: { run_id, answers: "Lanes" } });
    await runner!.idle();
    expect(store.get_run(run_id)).toMatchObject({ state: "done", answers: "Lanes" });
  });

  it("refuses the runner and stages to a user who is not an admin, who still adds and edits items", async () => {
    const { user } = await server_endpoint();

    expect(answer(await user("tools/call", { name: "start_run", arguments: { item_id: "item-1", options: {} } }))).toMatchObject({ error: true, value: expect.stringContaining("needs an admin's token") });
    expect(answer(await user("tools/call", { name: "save_stage", arguments: { stage: {}, original_id: null } }))).toMatchObject({ error: true });
    expect(answer(await user("tools/call", { name: "save_item", arguments: { item: { title: "Typo in README", repository: "x-tech-laboratories/X-Dev", kind: "bug" } } })).error).toBe(false);
  });

  it("lets a read-only token read and nothing else, and refuses no token at all", async () => {
    const { reader, anyone } = await server_endpoint();

    expect(answer(await reader("tools/call", { name: "list_items", arguments: {} })).value).toEqual([]);
    expect(answer(await reader("tools/call", { name: "save_item", arguments: { item: { title: "Nope", repository: "x-tech-laboratories/X-Dev" } } })).error).toBe(true);
    expect(await anyone()).toBe(401);
  });

  it("lets an Add items token add items over MCP and read, and refuses it anything that runs or edits", async () => {
    const { adder, database } = await server_endpoint();

    const added = answer(await adder("tools/call", { name: "add_item", arguments: { input: { title: "Swimlanes on the board", repository: make_checkout() } } }));
    expect(added).toMatchObject({ error: false, value: { repository: "x-tech-laboratories/X-Dev", issue: { number: 42 } } });
    const id = (added.value as { id: string }).id;
    expect(answer(await adder("tools/call", { name: "lookup_item", arguments: { repository: "X-Tech-Laboratories/x-dev", issue_number: 42 } })).value).toMatchObject({ id, title: "Swimlanes on the board" });

    const kept_to = "This token is kept to Add items";
    expect(answer(await adder("tools/call", { name: "start_run", arguments: { item_id: id, options: {} } }))).toMatchObject({ error: true, value: expect.stringContaining(kept_to) });
    expect(answer(await adder("tools/call", { name: "describe_item", arguments: { text: "A board" } }))).toMatchObject({ error: true, value: expect.stringContaining(kept_to) });
    expect(answer(await adder("tools/call", { name: "save_item", arguments: { item: { id, title: "Renamed", repository: "x-tech-laboratories/X-Dev" } } }))).toMatchObject({ error: true, value: expect.stringContaining(kept_to) });
    expect(bind_methods(() => database, () => undefined).get_item(id).title).toBe("Swimlanes on the board");
    expect(runner!.methods.get_runner().running_run_id).toBeNull();
  });

  it("lets an Add items token add items on the API and post the calls that read, and refuses the rest", async () => {
    const { post, tokens } = await server_endpoint();

    const added = await post(tokens.adder, "/api/runner/add_item", [{ title: "Swimlanes on the board", repository: make_checkout() }]);
    expect(added.status).toBe(200);
    const id = (JSON.parse(added.text) as { id: string }).id;
    expect(await post(tokens.adder, "/api/call/list_items", [])).toMatchObject({ status: 200, text: expect.stringContaining("Swimlanes on the board") });
    expect(await post(tokens.adder, "/api/call/lookup_item", { repository: "x-tech-laboratories/X-Dev", issue_number: 42 })).toMatchObject({ status: 200, text: expect.stringContaining(id) });

    expect(await post(tokens.adder, "/api/runner/start_run", [id, {}])).toMatchObject({ status: 403, text: expect.stringContaining("which does not include start_run") });
    expect(await post(tokens.adder, "/api/call/save_item", [{ id, title: "Renamed", repository: "x-tech-laboratories/X-Dev" }])).toMatchObject({ status: 403 });
    expect(await post(tokens.adder, "/api/stages/save_stage", [{}, null])).toMatchObject({ status: 403 });
    expect(runner!.methods.get_runner().running_run_id).toBeNull();

    expect(await post(tokens.reader, "/api/call/list_items", [])).toMatchObject({ status: 200 });
    expect(await post(tokens.reader, "/api/runner/add_item", [{ title: "Nope", repository: "x-tech-laboratories/X-Dev" }])).toMatchObject({ status: 403, text: expect.stringContaining("This token can only read.") });
  });

  it("follows a run until it changes over MCP and the API, and lists its waiting approvals", async () => {
    const { admin, post, session, base } = await server_endpoint();
    const id = (answer(await admin("tools/call", { name: "add_item", arguments: { input: { title: "Swimlanes on the board", repository: make_checkout(), body: "ASK STATUS" } } })).value as { id: string }).id;
    const run_id = answer(await admin("tools/call", { name: "start_run", arguments: { item_id: id, options: { stage: "plan" } } })).value as string;

    let update = answer(await admin("tools/call", { name: "get_run_update", arguments: { run_id, timeout_seconds: 20 } })).value as { changed: boolean; run: { state: string } };
    while (update.run.state === "running") update = answer(await admin("tools/call", { name: "get_run_update", arguments: { run_id, timeout_seconds: 20 } })).value as typeof update;
    expect(update).toMatchObject({ changed: true, run: { id: run_id, state: "waiting", question: "Which board layout?", permissions: [] } });
    expect(answer(await admin("tools/call", { name: "list_permission_requests", arguments: { run_id } })).value).toEqual([]);

    const token = ((await (await fetch(`${base}/api/account/tokens`, { method: "POST", headers: { "content-type": "application/json", cookie: session }, body: JSON.stringify({ name: "full", read_only: false }) })).json()) as { token: string }).token;
    const over_api = await post(token, "/api/runner/get_run_update", [run_id, 0]);
    expect(over_api.status).toBe(200);
    expect(JSON.parse(over_api.text)).toMatchObject({ changed: false, run: { state: "waiting" } });
  });

  it("refuses to loosen permissions or name another program", async () => {
    const { admin } = await server_endpoint();

    const refused = answer(await admin("tools/call", { name: "set_runner_setting", arguments: { key: "permission_mode", value: "bypassPermissions" } }));
    expect(refused).toMatchObject({ error: true, value: expect.stringContaining("only from X-Dev on the computer that runs the agents") });
    expect(runner!.methods.get_runner().settings.permission_mode).toBe("auto");
  });

  it("tells a client to add an item first", () => {
    expect(mcp_instructions).toMatch(/^To add an item, call add_item/);
  });
});

describe("the desktop daemon's local MCP endpoint", () => {
  it("is off until turned on, then listens on 127.0.0.1 alone and adds an item with its issue", async () => {
    const parts = await daemon_parts();
    const settings_file = join(mkdtempSync(join(tmpdir(), "x-dev-mcp-")), "mcp.json");
    const call = create_mcp_call({ database: () => parts.database, announce: () => undefined, stages: parts.stages, runner: parts.runner.methods });
    local = create_local_mcp({ name: "x-dev", version: "0.0.0", instructions: mcp_instructions, api: mcp_api(true), is_read_only, settings_file, default_port: 0, call });
    await local.start();
    expect((await local.methods.get_local_mcp_status()).state).toBe("off");

    local.methods.set_local_mcp_settings({ enabled: true, port: 0 });
    await local.start();
    const status = await local.methods.get_local_mcp_status();
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const added = answer(await mcp(status.url, {}, "tools/call", { name: "add_item", arguments: { input: { title: "Swimlanes on the board", repository: make_checkout() } } }));
    expect(added.value).toMatchObject({ repository: "x-tech-laboratories/X-Dev", issue: { number: 42 } });
    const refused = answer(await mcp(status.url, {}, "tools/call", { name: "set_runner_setting", arguments: { key: "claude_program", value: "/bin/sh" } }));
    expect(refused.error).toBe(true);
  });

  it("with Require a token on, turns away a caller without the token kept in the profile", async () => {
    const parts = await daemon_parts();
    const profile = mkdtempSync(join(tmpdir(), "x-dev-mcp-"));
    const call = create_mcp_call({ database: () => parts.database, announce: () => undefined, stages: parts.stages, runner: parts.runner.methods });
    local = create_local_mcp({ name: "x-dev", version: "0.0.0", instructions: mcp_instructions, api: mcp_api(true), is_read_only, settings_file: join(profile, "mcp.json"), token_file: join(profile, "mcp-token"), default_port: 0, call });
    expect(local.methods.get_local_mcp_settings().require_token).toBe(false);

    local.methods.set_local_mcp_settings({ enabled: true, port: 0, require_token: true });
    await local.start();
    const status = await local.methods.get_local_mcp_status();
    expect(status.token_file).toBe(join(profile, "mcp-token"));
    expect((statSync(status.token_file!).mode & 0o777).toString(8)).toBe("600");

    const without = await fetch(status.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(without.status).toBe(401);
    const header = local_mcp_client_config("x-dev", status)!.mcpServers["x-dev"]!.headers!;
    expect(answer(await mcp(status.url, header, "tools/call", { name: "list_items", arguments: {} })).value).toEqual([]);
  });
});
