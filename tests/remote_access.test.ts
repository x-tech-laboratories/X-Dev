import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { create_remote_access, type RemoteAccess } from "../src/daemon/remote_access.ts";
import { build_app } from "../src/server/app.ts";
import { create_stage_files } from "../src/server/stage_files.ts";
import { read_remote_access, remote_access_problem } from "../src/shared/remote_access.ts";
import type { RunnerMethods } from "../src/shared/runs/runner.ts";
import { open_store } from "../src/shared/store.ts";
import { free_port } from "./helpers/loopback.ts";

const password = "a long enough password";
let remote: RemoteAccess | null = null;

afterEach(async () => {
  await remote?.stop();
});

function setup() {
  const profile = mkdtempSync(join(tmpdir(), "x-dev-remote-"));
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  const start_run = vi.fn(async () => "run-1");
  const runner = { get_runner: () => ({ settings: {}, running_run_id: null }), start_run } as unknown as RunnerMethods;
  const backups = { list_backups: async () => [], create_backup: async () => ({}), restore_backup: async () => undefined, remove_backup: async () => undefined, get_backup_schedule: () => ({}), set_backup_schedule: () => undefined } as never;
  remote = create_remote_access({ profile, build: (admins, https) => build_app({ database, declared: admins, web_folder: "/nonexistent", backups, stages, runner, ...(https ? { https } : {}) }) });
  return { profile, remote, start_run };
}

describe("letting other devices connect", () => {
  it("stays off the network until turned on with an admin", async () => {
    const { remote } = setup();
    const port = await free_port();

    expect(remote.methods.get_remote_access()).toMatchObject({ settings: { enabled: false }, listening: "" });
    const without_admin = await remote.methods.set_remote_access({ enabled: true, host: "127.0.0.1", port, certificate_file: "", key_file: "" });
    expect(without_admin).toMatchObject({ listening: "", problem: "Add an admin first, so a device has someone to sign in as." });
    await expect(fetch(`http://127.0.0.1:${port}/api/abilities`)).rejects.toThrow();
  });

  it("signs in the admins it keeps and lets them start runs from another device", async () => {
    const { profile, remote, start_run } = setup();
    const port = await free_port();
    await remote.methods.set_remote_access({ enabled: true, host: "127.0.0.1", port, certificate_file: "", key_file: "" });

    const status = await remote.methods.set_remote_admin("Root", password);
    expect(status).toMatchObject({ admins: ["root"], listening: `http://127.0.0.1:${port}`, problem: "" });
    const kept = readFileSync(join(profile, "remote-admins"), "utf8");
    expect(kept).toMatch(/^root:scrypt\$/);
    expect(kept).not.toContain(password);
    expect(statSync(join(profile, "remote-admins")).mode & 0o777).toBe(0o600);

    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/api/runner/start_run`, { method: "POST", headers: { "content-type": "application/json" }, body: "[]" })).status).toBe(401);
    const { token } = (await (await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "root", password, device: "phone" }) })).json()) as { token: string };
    const started = await fetch(`${base}/api/runner/start_run`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(["item-1", {}]) });
    expect(await started.json()).toBe("run-1");
    expect(start_run).toHaveBeenCalledWith("item-1", {});
  });

  it("stops listening when turned off, and forgets a removed admin", async () => {
    const { remote } = setup();
    const port = await free_port();
    await remote.methods.set_remote_admin("root", password);
    await remote.methods.set_remote_access({ enabled: true, host: "127.0.0.1", port, certificate_file: "", key_file: "" });

    expect((await remote.methods.remove_remote_admin("root")).problem).toBe("Add an admin first, so a device has someone to sign in as.");
    await remote.methods.set_remote_admin("root", password);
    const off = await remote.methods.set_remote_access({ enabled: false, host: "127.0.0.1", port, certificate_file: "", key_file: "" });

    expect(off.listening).toBe("");
    await expect(fetch(`http://127.0.0.1:${port}/api/abilities`)).rejects.toThrow();
  });

  it("refuses short passwords and names that are not account names", async () => {
    const { remote } = setup();

    await expect(remote.methods.set_remote_admin("root", "short")).rejects.toThrow("at least 10 characters");
    await expect(remote.methods.set_remote_admin("no spaces", password)).rejects.toThrow("lowercase letters");
  });

  it("says why it cannot listen, such as a missing certificate file", async () => {
    const { remote } = setup();
    await remote.methods.set_remote_admin("root", password);

    const status = await remote.methods.set_remote_access({ enabled: true, host: "127.0.0.1", port: await free_port(), certificate_file: "/nonexistent/cert.pem", key_file: "/nonexistent/key.pem" });

    expect(status.listening).toBe("");
    expect(status.problem).toContain("/nonexistent/cert.pem");
  });
});

describe("remote access settings", () => {
  it("fall back to their defaults where missing or damaged", () => {
    expect(read_remote_access(null)).toEqual({ enabled: false, host: "0.0.0.0", port: 7760, certificate_file: "", key_file: "" });
    expect(read_remote_access({ enabled: true, host: "bad host;", port: 70000, certificate_file: " /c.pem " })).toEqual({ enabled: true, host: "0.0.0.0", port: 7760, certificate_file: "/c.pem", key_file: "" });
  });

  it("need both https files or neither", () => {
    const settings = { ...read_remote_access(null), enabled: true, certificate_file: "/c.pem" };

    expect(remote_access_problem(settings, ["root"])).toBe("Give both the certificate and its key, or neither.");
    expect(remote_access_problem({ ...settings, key_file: "/k.pem" }, ["root"])).toBe("");
    expect(remote_access_problem({ ...settings, enabled: false }, [])).toBe("");
  });
});
