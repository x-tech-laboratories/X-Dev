import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";

import { build_app } from "../src/server/app.ts";
import { create_github_sync } from "../src/server/github_sync.ts";
import { create_github_webhooks, create_webhook_sync, items_named } from "../src/server/github_webhooks.ts";
import { is_admin_tool, mcp_api } from "../src/server/mcp_calls.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import { set_item_github } from "../src/shared/items/github.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";
import { delivery_id_of, payload_url_of, read_public_url, read_targets, targets_of, type WebhookTargets } from "../src/shared/webhooks/model.ts";
import { list_deliveries, record_delivery } from "../src/shared/webhooks/store.ts";

const fake_gh = join(import.meta.dirname, "fixtures", "fake_gh.mjs");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.FAKE_GH_DATA;
});

function setup(options: { program?: boolean; now?: () => Date } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "x-dev-webhooks-"));
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const on_targets = vi.fn<(targets: WebhookTargets) => void>();
  const after_write = vi.fn();
  const webhooks = create_github_webhooks({
    database: () => database,
    secret_file: join(folder, "github-webhook-secret"),
    settings_file: join(folder, "github-webhook.json"),
    after_write,
    on_targets,
    ...(options.program ? { program: () => fake_gh } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { folder, database, webhooks, on_targets, after_write, store: bind_methods(() => database, () => undefined) };
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const pull_request_body = JSON.stringify({ action: "synchronize", number: 12, repository: { full_name: "owner/repo" }, pull_request: { number: 12, head: { ref: "worktree-item-7", repo: { full_name: "owner/repo" } } } });

function delivery(body: string, secret: string, event = "pull_request", id = "d-1"): IncomingHttpHeaders {
  return { "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": sign(body, secret), "content-type": "application/json" };
}

describe("what a delivery names", () => {
  it("reads the repository and the pull requests, branches and issues of each event, and nothing else", () => {
    expect(targets_of("pull_request", JSON.parse(pull_request_body))).toEqual({ repository: "owner/repo", pull_requests: [12], branches: ["worktree-item-7"], issues: [] });
    // A fork's branch is not the repository's own.
    expect(targets_of("pull_request", { repository: { full_name: "owner/repo" }, pull_request: { number: 3, head: { ref: "main", repo: { full_name: "someone/fork" } } } })?.branches).toEqual([]);
    expect(targets_of("check_suite", { repository: { full_name: "owner/repo" }, check_suite: { head_branch: "topic", pull_requests: [{ number: 4 }, { number: "5" }] } })).toEqual({ repository: "owner/repo", pull_requests: [4], branches: ["topic"], issues: [] });
    expect(targets_of("check_run", { repository: { full_name: "owner/repo" }, check_run: { check_suite: { head_branch: "topic" }, pull_requests: [{ number: 4 }] } })).toEqual({ repository: "owner/repo", pull_requests: [4], branches: ["topic"], issues: [] });
    expect(targets_of("workflow_run", { repository: { full_name: "owner/repo" }, workflow_run: { head_branch: "topic", pull_requests: [] } })?.branches).toEqual(["topic"]);
    expect(targets_of("status", { repository: { full_name: "owner/repo" }, branches: [{ name: "a" }, { name: "a" }, { name: "$(rm -rf ~)" }, { name: "../up" }] })?.branches).toEqual(["a"]);
    expect(targets_of("issues", { repository: { full_name: "owner/repo" }, issue: { number: 7 } })?.issues).toEqual([7]);
    expect(targets_of("issue_comment", { repository: { full_name: "owner/repo" }, issue: { number: 7 }, comment: { body: "run this" } })).toEqual({ repository: "owner/repo", pull_requests: [], branches: [], issues: [7] });
    expect(targets_of("ping", { repository: { full_name: "owner/repo" }, zen: "Keep it simple." })).toEqual({ repository: "owner/repo", pull_requests: [], branches: [], issues: [] });
  });

  it("follows no other event, and no payload without a repository that looks like one", () => {
    expect(targets_of("push", { repository: { full_name: "owner/repo" } })).toBeNull();
    expect(targets_of("issues", { issue: { number: 7 } })).toBeNull();
    expect(targets_of("issues", { repository: { full_name: "owner/repo; echo" } })).toBeNull();
    expect(targets_of("issues", null)).toBeNull();
  });

  it("reads stored targets, ids and addresses as given or not at all", () => {
    expect(read_targets("owner/repo", "not json")).toEqual({ repository: "owner/repo", pull_requests: [], branches: [], issues: [] });
    expect(read_targets("owner/repo", JSON.stringify({ pull_requests: [1, -2], branches: ["a", 3], issues: [4] }))).toEqual({ repository: "owner/repo", pull_requests: [1], branches: ["a"], issues: [4] });
    expect(delivery_id_of("72d3162e-cc78-11e3-81ab-4c9367dc0958")).toBe("72d3162e-cc78-11e3-81ab-4c9367dc0958");
    expect(delivery_id_of("bad id")).toBe("");
    expect(payload_url_of("https://dev.example.org/")).toBe("https://dev.example.org/api/github/webhook");
    expect(payload_url_of(" ")).toBe("");
    expect(read_public_url(" https://dev.example.org/x-dev/ ")).toBe("https://dev.example.org/x-dev");
    expect(read_public_url("")).toBe("");
    expect(() => read_public_url("ftp://dev.example.org")).toThrow(/http or https/);
    expect(() => read_public_url("not an address")).toThrow(/address/);
  });
});

describe("taking a delivery", () => {
  it("refuses every delivery until a secret is made, then any without GitHub's signature of the body", () => {
    const { webhooks, on_targets } = setup();
    expect(webhooks.receive("10.0.0.1", delivery(pull_request_body, "anything"), Buffer.from(pull_request_body)).status).toBe(401);

    webhooks.methods.create_github_webhook_secret();
    const secret = webhooks.methods.show_github_webhook_setup().secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(webhooks.receive("10.0.0.1", delivery(pull_request_body, "wrong secret"), Buffer.from(pull_request_body)).status).toBe(401);
    expect(webhooks.receive("10.0.0.1", { "x-github-event": "pull_request" }, Buffer.from(pull_request_body)).status).toBe(401);
    // A bearer token or another forge's header is not GitHub's signature.
    expect(webhooks.receive("10.0.0.1", { "x-github-event": "pull_request", authorization: `Bearer ${secret}` }, Buffer.from(pull_request_body)).status).toBe(401);
    expect(webhooks.receive("10.0.0.1", { "x-github-event": "pull_request", "x-gitea-signature": sign(pull_request_body, secret).slice(7) }, Buffer.from(pull_request_body)).status).toBe(401);
    // The signature covers the exact bytes, so a changed body is refused.
    expect(webhooks.receive("10.0.0.1", delivery(pull_request_body, secret), Buffer.from(pull_request_body.replace("12", "13"))).status).toBe(401);
    expect(on_targets).not.toHaveBeenCalled();
  });

  it("keeps a signed delivery as its repository's latest and passes on what it names, once", () => {
    const { webhooks, on_targets, after_write, database } = setup({ now: () => new Date("2026-11-20T10:00:00.000Z") });
    webhooks.methods.create_github_webhook_secret();
    const secret = webhooks.methods.show_github_webhook_setup().secret;

    const answer = webhooks.receive("10.0.0.1", delivery(pull_request_body, secret), Buffer.from(pull_request_body));
    expect(answer).toEqual({ status: 202, body: { message: "Received." } });
    expect(on_targets).toHaveBeenCalledWith({ repository: "owner/repo", pull_requests: [12], branches: ["worktree-item-7"], issues: [] });
    expect(after_write).toHaveBeenCalledTimes(1);
    expect(list_deliveries(database)).toEqual([{ repository: "owner/repo", delivery_id: "d-1", event: "pull_request", received_at: "2026-11-20T10:00:00.000Z", targets: { repository: "owner/repo", pull_requests: [12], branches: ["worktree-item-7"], issues: [] } }]);

    // GitHub's Redeliver sends the same id again.
    expect(webhooks.receive("10.0.0.1", delivery(pull_request_body, secret), Buffer.from(pull_request_body))).toEqual({ status: 200, body: { message: "Already received." } });
    expect(on_targets).toHaveBeenCalledTimes(1);
  });

  it("answers a ping without a sync, and ignores events it does not follow", () => {
    const { webhooks, on_targets, database } = setup();
    webhooks.methods.create_github_webhook_secret();
    const secret = webhooks.methods.show_github_webhook_setup().secret;
    const ping = JSON.stringify({ zen: "Design for failure.", repository: { full_name: "owner/repo" } });
    expect(webhooks.receive("10.0.0.1", delivery(ping, secret, "ping", "p-1"), Buffer.from(ping))).toEqual({ status: 202, body: { message: "Pong." } });
    expect(list_deliveries(database)[0]?.event).toBe("ping");

    const push = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "owner/repo" } });
    expect(webhooks.receive("10.0.0.1", delivery(push, secret, "push", "p-2"), Buffer.from(push)).status).toBe(204);
    const org = JSON.stringify({ action: "created" });
    expect(webhooks.receive("10.0.0.1", delivery(org, secret, "issues", "p-3"), Buffer.from(org)).status).toBe(204);
    expect(on_targets).not.toHaveBeenCalled();
  });

  it("turns away an address that keeps failing to sign", () => {
    const { webhooks } = setup();
    webhooks.methods.create_github_webhook_secret();
    for (let attempt = 0; attempt < 10; attempt++) webhooks.receive("10.0.0.9", delivery(pull_request_body, "guess"), Buffer.from(pull_request_body));
    const secret = webhooks.methods.show_github_webhook_setup().secret;
    expect(webhooks.receive("10.0.0.9", delivery(pull_request_body, secret), Buffer.from(pull_request_body)).status).toBe(429);
    expect(webhooks.receive("10.0.0.2", delivery(pull_request_body, secret), Buffer.from(pull_request_body)).status).toBe(202);
  });

  it("passes on deliveries another host kept once they arrive by sync, but not ones from before it started or long ago", () => {
    const now = new Date("2026-11-20T10:00:00.000Z");
    const { webhooks, on_targets, database } = setup({ now: () => now });
    const targets = { repository: "owner/repo", pull_requests: [], branches: [], issues: [7] };
    record_delivery(database, { repository: "owner/repo", delivery_id: "old", event: "issues", received_at: "2026-11-20T09:59:00.000Z", targets });
    webhooks.catch_up();
    expect(on_targets).not.toHaveBeenCalled();

    record_delivery(database, { repository: "owner/repo", delivery_id: "new", event: "issues", received_at: "2026-11-20T09:59:30.000Z", targets });
    webhooks.catch_up();
    webhooks.catch_up();
    expect(on_targets).toHaveBeenCalledTimes(1);
    expect(on_targets).toHaveBeenCalledWith(targets);

    record_delivery(database, { repository: "other/repo", delivery_id: "stale", event: "issues", received_at: "2026-11-20T08:00:00.000Z", targets: { ...targets, repository: "other/repo" } });
    webhooks.catch_up();
    expect(on_targets).toHaveBeenCalledTimes(1);
    expect(webhooks.heard_recently("Owner/Repo")).toBe(true);
    expect(webhooks.heard_recently("other/repo")).toBe(false);
  });
});

describe("the secret", () => {
  it("is kept in a file only its user reads, and never given by the read call or written to the log", () => {
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const { webhooks, folder } = setup();
    expect(webhooks.methods.get_github_webhook().has_secret).toBe(false);
    expect(() => webhooks.methods.show_github_webhook_setup()).toThrow(/secret first/);

    const created = webhooks.methods.create_github_webhook_secret();
    const secret = webhooks.methods.show_github_webhook_setup().secret;
    expect(statSync(join(folder, "github-webhook-secret")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(folder, "github-webhook-secret"), "utf8").trim()).toBe(secret);
    expect(created.has_secret).toBe(true);
    webhooks.methods.set_github_webhook_url("https://dev.example.org");
    webhooks.receive("10.0.0.1", delivery(pull_request_body, secret), Buffer.from(pull_request_body));
    webhooks.receive("10.0.0.1", delivery(pull_request_body, "bad"), Buffer.from(pull_request_body));
    for (const answer of [created, webhooks.methods.get_github_webhook()]) expect(JSON.stringify(answer)).not.toContain(secret);
    expect(readFileSync(join(folder, "github-webhook.json"), "utf8")).not.toContain(secret);
    for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);

    webhooks.methods.create_github_webhook_secret();
    expect(webhooks.methods.show_github_webhook_setup().secret).not.toBe(secret);
    expect(webhooks.receive("10.0.0.1", delivery(pull_request_body, secret, "pull_request", "d-2"), Buffer.from(pull_request_body)).status).toBe(401);
  });

  it("makes the payload URL from the public address and refuses one that is not an address", () => {
    const { webhooks } = setup();
    expect(webhooks.methods.set_github_webhook_url("https://dev.example.org/").payload_url).toBe("https://dev.example.org/api/github/webhook");
    expect(() => webhooks.methods.set_github_webhook_url("https://dev.example.org/?token=x")).toThrow();
    expect(webhooks.methods.get_github_webhook()).toMatchObject({ public_url: "https://dev.example.org", content_type: "application/json", can_register: false, events: ["pull_request", "check_suite", "check_run", "status", "workflow_run", "issues", "issue_comment"] });
  });
});

describe("adding the hook through gh", () => {
  function fake_github() {
    const file = join(mkdtempSync(join(tmpdir(), "x-dev-github-")), "github.json");
    writeFileSync(file, JSON.stringify({ issues: {}, labels: [], pulls: [], checks: {}, next_comment_id: 1, calls: [] }));
    process.env.FAKE_GH_DATA = file;
    return () => JSON.parse(readFileSync(file, "utf8")) as { calls: string[][]; hooks: Record<string, { id: number; events: string[]; config: { url: string; secret: string; content_type: string } }[]> };
  }

  it("adds it once, then updates the same hook, the secret going on standard input and never on the command line", async () => {
    const read = fake_github();
    const { webhooks } = setup({ program: true });
    await expect(webhooks.methods.register_github_webhook("owner/repo")).rejects.toThrow(/public address/);
    webhooks.methods.set_github_webhook_url("https://dev.example.org");
    await expect(webhooks.methods.register_github_webhook("owner/repo")).rejects.toThrow(/secret first/);
    await expect(webhooks.methods.register_github_webhook("owner/repo; rm")).rejects.toThrow(/owner\/name/);
    webhooks.methods.create_github_webhook_secret();
    const secret = webhooks.methods.show_github_webhook_setup().secret;

    expect(await webhooks.methods.register_github_webhook(" owner/repo ")).toBe("Added the webhook to owner/repo.");
    webhooks.methods.create_github_webhook_secret();
    const replaced = webhooks.methods.show_github_webhook_setup().secret;
    expect(await webhooks.methods.register_github_webhook("owner/repo")).toBe("Updated the webhook on owner/repo.");

    const github = read();
    expect(github.hooks["owner/repo"]).toHaveLength(1);
    expect(github.hooks["owner/repo"]![0]).toMatchObject({ events: ["pull_request", "check_suite", "check_run", "status", "workflow_run", "issues", "issue_comment"], config: { url: "https://dev.example.org/api/github/webhook", content_type: "json", secret: replaced } });
    expect(github.calls).toContainEqual(["--method", "PATCH", "repos/owner/repo/hooks/1", "--input", "-"]);
    for (const value of [secret, replaced]) expect(JSON.stringify(github.calls)).not.toContain(value);
  });

  it("is refused where no gh runs, such as the server", async () => {
    const { webhooks } = setup();
    webhooks.methods.set_github_webhook_url("https://dev.example.org");
    webhooks.methods.create_github_webhook_secret();
    await expect(webhooks.methods.register_github_webhook("owner/repo")).rejects.toThrow(/computer that runs the agents/);
  });
});

describe("syncing what a delivery named", () => {
  function items(store: ReturnType<typeof setup>["store"], database: DatabaseSync) {
    const by_issue = store.save_item({ title: "By issue", repository: "Owner/Repo", issue_number: 7, stage: "plan" });
    const by_branch = store.save_item({ title: "By branch", repository: "owner/repo", issue_number: 8, stage: "review" });
    database.prepare("UPDATE items SET branch = 'worktree-item-8' WHERE id = ?").run(by_branch);
    const by_pull = store.save_item({ title: "By pull request", repository: "owner/repo", issue_number: 9, stage: "review" });
    set_item_github(database, by_pull, { pull_request: { number: 21, url: "https://github.com/owner/repo/pull/21", state: "open", draft: false, checks: [], changed_at: "" } });
    const elsewhere = store.save_item({ title: "Elsewhere", repository: "other/repo", issue_number: 7, stage: "plan" });
    const closed = store.save_item({ title: "Closed", repository: "owner/repo", issue_number: 10, stage: "plan" });
    store.close_item(closed);
    return { by_issue, by_branch, by_pull, elsewhere, closed };
  }

  it("finds the open items of the repository by issue, branch or pull request", () => {
    const { store, database } = setup();
    const { by_issue, by_branch, by_pull } = items(store, database);
    expect(items_named(database, { repository: "owner/repo", pull_requests: [], branches: [], issues: [7] })).toEqual([by_issue]);
    expect(items_named(database, { repository: "owner/repo", pull_requests: [], branches: ["worktree-item-8"], issues: [] })).toEqual([by_branch]);
    expect(items_named(database, { repository: "owner/repo", pull_requests: [21], branches: [], issues: [] })).toEqual([by_pull]);
    // An issue comment on a pull request names it by its number as an issue.
    expect(items_named(database, { repository: "owner/repo", pull_requests: [], branches: [], issues: [21] })).toEqual([by_pull]);
    expect(items_named(database, { repository: "owner/repo", pull_requests: [], branches: [], issues: [10, 99] })).toEqual([]);
    expect(items_named(database, { repository: "owner/repo", pull_requests: [], branches: [""], issues: [] })).toEqual([]);
  });

  it("makes one sync per item from a burst of deliveries, once the burst is over", () => {
    vi.useFakeTimers();
    const { store, database } = setup();
    const { by_branch, by_pull } = items(store, database);
    const sync_item = vi.fn(async () => "");
    const webhook_sync = create_webhook_sync({ database: () => database, sync_item, delay_seconds: 5 });
    for (let check = 0; check < 6; check++) webhook_sync.sync_targets({ repository: "owner/repo", pull_requests: [21], branches: ["worktree-item-8"], issues: [] });
    vi.advanceTimersByTime(4000);
    expect(sync_item).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(sync_item).toHaveBeenCalledTimes(2);
    expect(sync_item).toHaveBeenCalledWith(by_branch, { find_pull_request: true });
    expect(sync_item).toHaveBeenCalledWith(by_pull, { find_pull_request: true });

    webhook_sync.sync_targets({ repository: "owner/repo", pull_requests: [21], branches: [], issues: [] });
    webhook_sync.close();
    vi.advanceTimersByTime(10_000);
    expect(sync_item).toHaveBeenCalledTimes(2);
  });

  it("polls a repository heard by webhook only every idle interval", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "x-dev-github-")), "github.json");
    writeFileSync(file, JSON.stringify({ issues: { "7": { state: "OPEN", labels: [], body: "", comments: [] } }, labels: [], pulls: [], checks: {}, next_comment_id: 1, calls: [] }));
    process.env.FAKE_GH_DATA = file;
    const { store, database } = setup();
    store.save_item({ title: "Quiet", repository: "owner/repo", issue_number: 7, stage: "plan" });
    let clock = 1_000_000;
    let quiet = true;
    const sync = create_github_sync({ database: () => database, program: () => fake_gh, after_write: () => undefined, idle_interval: 60, quiet_repository: () => quiet, clock: () => clock });
    const calls = () => (JSON.parse(readFileSync(file, "utf8")) as { calls: unknown[] }).calls.length;

    await sync.sync_all();
    const first = calls();
    expect(first).toBeGreaterThan(0);
    // Once synced the item asks nothing more of GitHub, so a sync shows only as the item's issue being read again after a change.
    store.update_item_status(store.list_items(false)[0]!.id, { goal: "Changed." });
    clock += 30_000;
    await sync.sync_all();
    expect(calls()).toBe(first);
    clock += 30_000;
    await sync.sync_all();
    expect(calls()).toBeGreaterThan(first);

    const second = calls();
    store.update_item_status(store.list_items(false)[0]!.id, { goal: "Changed again." });
    quiet = false;
    await sync.sync_all();
    expect(calls()).toBeGreaterThan(second);
  });
});

describe("the endpoint", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start() {
    const { webhooks, on_targets } = setup();
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
    const backups = { list_backups: async () => [], create_backup: async () => ({ name: "", taken_at: "", is_automatic: false, size_bytes: 0 }), restore_backup: async () => undefined, remove_backup: async () => undefined, get_backup_schedule: () => ({ automatic: true, to_keep: 14 }), set_backup_schedule: () => undefined };
    const password = "a long enough password";
    app = await build_app({ database, declared: new Map([["root", hash_password(password)]]), web_folder: "/nonexistent", backups, stages, webhooks });
    const token = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password, device: "tests" } })).json<{ token: string }>().token;
    return { app, webhooks, on_targets, token };
  }

  it("takes GitHub's deliveries without a session, judged by their signature over the raw body", async () => {
    const { app, webhooks, on_targets } = await start();
    webhooks.methods.create_github_webhook_secret();
    const secret = webhooks.methods.show_github_webhook_setup().secret;
    // Spaces and key order a JSON parser would lose are part of what was signed.
    const body = pull_request_body.replace("{", "{ ");

    const good = await app.inject({ method: "POST", url: "/api/github/webhook", headers: delivery(body, secret), payload: body });
    expect(good.statusCode).toBe(202);
    expect(on_targets).toHaveBeenCalledTimes(1);
    const bad = await app.inject({ method: "POST", url: "/api/github/webhook", headers: delivery(body, "wrong", "pull_request", "d-9"), payload: body });
    expect(bad.statusCode).toBe(401);
    const unknown = await app.inject({ method: "POST", url: "/api/github/webhook", headers: delivery(body, secret, "star", "d-10"), payload: body });
    expect(unknown.statusCode).toBe(204);
  });

  it("gives the webhook calls to an admin alone, and tells the page it may", async () => {
    const { app, token } = await start();
    expect((await app.inject({ method: "POST", url: "/api/github_webhook/get_github_webhook", payload: [] })).statusCode).toBe(401);
    const created = await app.inject({ method: "POST", url: "/api/github_webhook/create_github_webhook_secret", payload: [], headers: { authorization: `Bearer ${token}` } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ has_secret: true });
    expect(created.body).not.toMatch(/[0-9a-f]{64}/);
    const shown = await app.inject({ method: "POST", url: "/api/github_webhook/show_github_webhook_setup", payload: [], headers: { authorization: `Bearer ${token}` } });
    expect(shown.json<{ secret: string }>().secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await app.inject({ method: "GET", url: "/api/abilities", headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ webhooks: true });
    const openapi = (await app.inject({ method: "GET", url: "/api/openapi.json", headers: { authorization: `Bearer ${token}` } })).body;
    expect(openapi).toContain("/api/github_webhook/register_github_webhook");
  });

  it("offers the webhook calls as MCP tools for an admin only where the host takes deliveries", () => {
    expect("show_github_webhook_setup" in mcp_api(false, true)).toBe(true);
    expect("show_github_webhook_setup" in mcp_api(true)).toBe(false);
    expect(is_admin_tool("get_github_webhook")).toBe(true);
    expect(is_admin_tool("list_items")).toBe(false);
  });
});
