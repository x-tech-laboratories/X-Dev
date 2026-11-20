// A desktop daemon reached from another device over loopback, as the desktop app's main process reaches one: over https
// with a self-signed certificate the device was told to trust, and over plain http. Certificates need openssl.

import { writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create_certificate_trust } from "@x-tech-laboratories/x-libs/certificates";
import { create_connections } from "@x-tech-laboratories/x-libs/connections";
import { create_daemon_link } from "@x-tech-laboratories/x-libs/daemon_link";

import type { Run } from "../src/shared/runs/model.ts";
import { admin, repository, start_test_daemon, type TestDaemon } from "./helpers/daemon.ts";
import { memory_connection_storage, self_signed_certificate, temp_folder } from "./helpers/loopback.ts";

let daemon: TestDaemon | null = null;
let stop_following = (): void => {};

beforeEach(() => {
  // The stand-in gh is signed in as test-user.
  const gh_state = join(temp_folder("gh"), "state");
  writeFileSync(gh_state, "test-user");
  vi.stubEnv("FAKE_GH_STATE", gh_state);
});

afterEach(async () => {
  stop_following();
  await daemon?.stop();
  daemon = null;
  vi.unstubAllEnvs();
});

// ============================================================================
// Device
// ============================================================================

// A device that signs in to the daemon as the admin, then sends its calls and follows its events through daemon_link.
async function connect(address: string) {
  const connections = create_connections({ storage: memory_connection_storage(), offers_local: false, device_name: "Test laptop" });
  await connections.methods.add_connection(address, admin, "Workstation");
  const link = create_daemon_link({ connections, socket_path: "/nonexistent/daemon.sock" });
  const events: string[] = [];
  stop_following = link.follow_events("/api/events", (event) => void events.push(event));
  await vi.waitFor(() => expect(events).toContain("hello"));
  return { link, events };
}

// Signs in, adds an item, runs its stage until the agent asks, answers it, and checks gh, all from the device.
async function work_through(daemon: TestDaemon, address: string): Promise<void> {
  const { link, events } = await connect(address);

  const item_id = (await link.call("/api/call/save_item", [{ title: "Board with swimlanes", repository, body: "ASK STATUS", stage: "plan", issue_number: 7 }])) as string;
  expect(daemon.store.get_item(item_id).title).toBe("Board with swimlanes");
  await vi.waitFor(() => expect(events).toContain("changed"));

  const run_id = (await link.call("/api/runner/start_run", [item_id, {}])) as string;
  await daemon.runner.idle();
  expect(((await link.call("/api/call/get_run", [run_id])) as Run).state).toBe("waiting");

  events.length = 0;
  await link.call("/api/runner/answer_run", [run_id, "Lanes."]);
  await daemon.runner.idle();
  expect((await link.call("/api/call/get_run", [run_id])) as Run).toMatchObject({ state: "done", answers: "Lanes.", next: "implement" });
  await vi.waitFor(() => expect(events).toContain("changed"));

  expect(await link.call("/api/runner/get_github", [])).toMatchObject({ account: "test-user" });
  await expect(link.call("/api/runner/set_runner_setting", ["claude_program", "/bin/sh"])).rejects.toThrow("changes only from X-Dev on the computer that runs the agents");
}

// An https request on a connection of its own, so nothing a trusted request left open is used again.
function fresh_https_get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request(url, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

// ============================================================================
// https
// ============================================================================

describe("a daemon on https with a self-signed certificate", () => {
  it("is refused until the device trusts its certificate, then signs in, runs a stage and follows its events", async () => {
    daemon = await start_test_daemon({ https: self_signed_certificate() });
    const address = daemon.address;
    expect(address).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);

    await expect(fetch(`${address}/api/abilities`)).rejects.toThrow();
    const untrusting = create_connections({ storage: memory_connection_storage(), offers_local: false, device_name: "Untrusting laptop" });
    await expect(untrusting.methods.add_connection(address, admin)).rejects.toThrow(/did not answer: self[- ]signed certificate/);

    const trust = create_certificate_trust({ file: join(temp_folder("trust"), "trusted-certificates.json"), use_in_node: true });
    const check = await trust.methods.check_certificate(address);
    expect(check).toMatchObject({ host: "127.0.0.1", problems: ["self_signed"], trusted: false });
    await trust.methods.trust_certificate(address, check!.chain[0]!.fingerprint);
    try {
      expect(await trust.methods.check_certificate(address)).toMatchObject({ trusted: true });
      await work_through(daemon, address);
    } finally {
      trust.methods.forget_certificate("127.0.0.1");
    }

    // Once forgotten, a new connection is refused again.
    await expect(fresh_https_get(`${address}/api/abilities`)).rejects.toThrow(/self[- ]signed certificate/);
  });

  it("refuses a certificate trusted for another daemon", async () => {
    daemon = await start_test_daemon({ https: self_signed_certificate() });
    const other = await start_test_daemon({ https: self_signed_certificate() });
    const trust = create_certificate_trust({ file: join(temp_folder("trust"), "trusted-certificates.json"), use_in_node: true });
    try {
      const check = await trust.methods.check_certificate(other.address);
      await trust.methods.trust_certificate(other.address, check!.chain[0]!.fingerprint);

      // The trusted daemon answers, asking for a sign-in.
      expect(await fresh_https_get(`${other.address}/api/abilities`)).toBe(401);
      await expect(fresh_https_get(`${daemon.address}/api/abilities`)).rejects.toThrow(/self[- ]signed certificate/);
    } finally {
      trust.methods.forget_certificate("127.0.0.1");
      await other.stop();
    }
  });
});

// ============================================================================
// http
// ============================================================================

describe("a daemon on plain http on loopback", () => {
  it("signs in, runs a stage and follows its events", async () => {
    daemon = await start_test_daemon();
    expect(daemon.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await work_through(daemon, daemon.address);
  });
});
