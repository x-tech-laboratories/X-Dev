import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";

import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";

import { build_app } from "../src/server/app.ts";
import { local_only_settings, remote_runner } from "../src/server/remote_runner.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import { runner_api } from "../src/shared/runs/api.ts";
import { runner_method_names, type RunnerMethods } from "../src/shared/runs/runner.ts";
import { open_store } from "../src/shared/store.ts";

let app: FastifyInstance;
const password = "a long enough password";

afterEach(async () => {
  await app?.close();
});

// A runner that records what it was asked and starts nothing.
function fake_runner() {
  return {
    get_runner: vi.fn(() => ({ settings: { repositories: {}, permission_mode: "auto", claude_program: "claude", describer_model: "haiku", gh_program: "gh" }, running_run_id: null })),
    set_runner_setting: vi.fn(),
    set_repository: vi.fn(),
    add_repository: vi.fn(async () => "x-tech-laboratories/X-Dev"),
    remove_repository: vi.fn(),
    start_run: vi.fn(async () => "run-1"),
    stop_run: vi.fn(),
    answer_run: vi.fn(),
    discard_run: vi.fn(async () => undefined),
    describe_item: vi.fn(),
    link_issue: vi.fn(),
    sync_github: vi.fn(async () => ""),
    get_github: vi.fn(async () => ({ signed_in: false, account: "", problem: "" })),
    sign_in_github: vi.fn(),
    sign_out_github: vi.fn(),
    get_changes: vi.fn(),
    get_file_change: vi.fn(),
    revert_file: vi.fn(),
    list_run_changes: vi.fn(async () => ({})),
    add_item: vi.fn(async () => ({ id: "item-1", repository: "x-tech-laboratories/X-Dev", issue: { number: 12, opened: true }, checkout_added: false, problem: "" })),
    take_proposal: vi.fn(),
    interject_run: vi.fn(),
    interrupt_run: vi.fn(async () => undefined),
    retry_run: vi.fn(async () => "run-2"),
    set_run_mode: vi.fn(async () => undefined),
    answer_permission: vi.fn(),
  } satisfies Record<keyof RunnerMethods, unknown>;
}

const no_backups = {
  list_backups: async () => [],
  create_backup: async () => ({ name: "", taken_at: "", is_automatic: false, size_bytes: 0 }),
  restore_backup: async () => undefined,
  remove_backup: async () => undefined,
  get_backup_schedule: () => ({ automatic: true, to_keep: 14 }),
  set_backup_schedule: () => undefined,
};

async function start(runner?: ReturnType<typeof fake_runner>) {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  app = await build_app({ database, declared: new Map([["root", hash_password(password)]]), web_folder: "/nonexistent", backups: no_backups, stages, ...(runner ? { runner: runner as unknown as RunnerMethods } : {}) });
  const admin_token = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password, device: "phone" } })).json().token as string;
  // A plain user, added by the admin from a browser session.
  const session = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password } })).headers["set-cookie"] as string;
  await app.inject({ method: "POST", url: "/api/users", headers: { cookie: session.split(";")[0]! }, payload: { name: "guest", password, role: "user" } });
  const user_token = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "guest", password, device: "laptop" } })).json().token as string;
  const as = (token: string) => (options: InjectOptions) => app.inject({ ...options, headers: { ...options.headers, authorization: `Bearer ${token}` } });
  return { admin: as(admin_token), user: as(user_token) };
}

describe("the runner over the network", () => {
  it("answers only a signed-in admin", async () => {
    const runner = fake_runner();
    const { admin, user } = await start(runner);

    expect((await app.inject({ method: "POST", url: "/api/runner/start_run", payload: ["item-1", {}] })).statusCode).toBe(401);
    expect((await user({ method: "POST", url: "/api/runner/start_run", payload: ["item-1", {}] })).statusCode).toBe(403);
    expect(runner.start_run).not.toHaveBeenCalled();

    const started = await admin({ method: "POST", url: "/api/runner/start_run", payload: ["item-1", { stage: "plan" }] });
    expect(started.json()).toBe("run-1");
    expect(runner.start_run).toHaveBeenCalledWith("item-1", { stage: "plan" });
  });

  it("refuses the settings that pick which programs run and how freely", async () => {
    const runner = fake_runner();
    const { admin } = await start(runner);

    for (const key of local_only_settings) {
      const refused = await admin({ method: "POST", url: "/api/runner/set_runner_setting", payload: [key, "/tmp/elsewhere"] });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect((await admin({ method: "POST", url: "/api/runner/set_runner_setting", payload: ["describer_model", "haiku"] })).statusCode).toBe(204);
    expect(runner.set_runner_setting).toHaveBeenCalledTimes(1);
  });

  it("tells the page whether it may run agents", async () => {
    const { admin, user } = await start(fake_runner());

    expect((await admin({ method: "GET", url: "/api/abilities" })).json()).toEqual({ runner: true, stages: true });
    expect((await user({ method: "GET", url: "/api/abilities" })).json()).toEqual({ runner: false, stages: false });
  });

  it("has no runner where none runs agents", async () => {
    const { admin } = await start();

    expect((await admin({ method: "GET", url: "/api/abilities" })).json()).toEqual({ runner: false, stages: true });
    expect((await admin({ method: "POST", url: "/api/runner/get_runner", payload: [] })).statusCode).toBe(404);
  });

  it("describes the runner and stage calls with the data calls", async () => {
    const { admin } = await start(fake_runner());

    const paths = Object.keys((await admin({ method: "GET", url: "/api/openapi.json" })).json().paths as object);
    expect(paths).toContain("/api/runner/start_run");
    expect(paths).toContain("/api/stages/save_stage");
    expect(paths).toContain("/api/call/list_items");
  });

  it("lets a phone's page call across origins, the sign-in included", async () => {
    await start();

    const preflight = await app.inject({ method: "OPTIONS", url: "/api/login", headers: { origin: "https://localhost", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    const signed_in = await app.inject({ method: "POST", url: "/api/login", headers: { origin: "https://localhost" }, payload: { name: "root", password, device: "phone" } });
    expect(signed_in.headers["access-control-allow-origin"]).toBe("*");
  });

  it("lets a phone's page follow the change events across origins", async () => {
    await start();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const device = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password, device: "phone" } })).json().token as string;

    const stream = new AbortController();
    const response = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/events`, { headers: { origin: "https://localhost", authorization: `Bearer ${device}` }, signal: stream.signal });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    stream.abort();
  });
});

describe("the remote runner", () => {
  it("passes every other call through", async () => {
    const runner = fake_runner();
    const remote = remote_runner(runner as unknown as RunnerMethods);

    await remote.start_run("item-1", {});
    remote.answer_run("run-1", "Yes.");

    expect(runner.start_run).toHaveBeenCalledWith("item-1", {});
    expect(runner.answer_run).toHaveBeenCalledWith("run-1", "Yes.");
    expect(() => remote.set_runner_setting("claude_program", "/bin/sh")).toThrow("only from X-Dev on the computer that runs the agents");
  });
});

describe("the remote runner's permission modes", () => {
  it("takes Manual from elsewhere but refuses a looser mode or allowing a tool for the whole run", async () => {
    const runner = fake_runner();
    const remote = remote_runner(runner as unknown as RunnerMethods);

    await remote.start_run("item-1", { mode: "default" });
    await remote.retry_run("run-1", { mode: "default" });
    await remote.set_run_mode("run-1", "default");
    remote.answer_permission("run-1", "p1", "allowed", "");
    expect(runner.start_run).toHaveBeenCalledWith("item-1", { mode: "default" });
    expect(runner.answer_permission).toHaveBeenCalledWith("run-1", "p1", "allowed", "");

    expect(() => remote.start_run("item-1", { mode: "auto" })).toThrow("picked only from X-Dev on the computer that runs the agents");
    expect(() => remote.retry_run("run-1", { mode: "acceptEdits" })).toThrow("Manual can be picked from here");
    expect(() => remote.set_run_mode("run-1", "auto")).toThrow("the auto permission mode");
    expect(() => remote.answer_permission("run-1", "p1", "allowed_for_run", "")).toThrow("allow this call alone from here");
  });
});

describe("the runner's calls", () => {
  it("are each described, so every host serves the same table", () => {
    expect(Object.keys(runner_api).sort()).toEqual([...runner_method_names].sort());
  });
});
