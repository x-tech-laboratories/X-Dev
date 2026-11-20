// A desktop daemon as src/daemon/main.ts puts one together, on a throwaway profile: its database, stages, runner with
// the stand-in claude and gh, and "Let other devices connect" turned on for one admin on a loopback port.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { EventStream } from "@x-tech-laboratories/x-libs/server/events";

import { create_remote_access } from "../../src/daemon/remote_access.ts";
import { build_app } from "../../src/server/app.ts";
import { create_run_tools } from "../../src/server/run_tools.ts";
import { create_runner } from "../../src/server/runner.ts";
import { create_stage_files } from "../../src/server/stage_files.ts";
import { bind_methods, open_store } from "../../src/shared/store.ts";
import { free_port, make_checkout, temp_folder } from "./loopback.ts";

export const admin = { name: "root", password: "a long enough password" };
export const repository = "x-tech-laboratories/X-Dev";
export const fake_claude = join(import.meta.dirname, "..", "fixtures", "fake_claude.mjs");
export const fake_gh = join(import.meta.dirname, "..", "fixtures", "fake_gh.mjs");

export interface TestDaemonOptions {
  // The certificate and key to serve https with; plain http without them.
  https?: { certificate_file: string; key_file: string };
}

export type TestDaemon = Awaited<ReturnType<typeof start_test_daemon>>;

// Stands in for backups, which these tests never take.
const no_backups = { list_backups: async () => [], create_backup: async () => ({}), restore_backup: async () => undefined, remove_backup: async () => undefined, get_backup_schedule: () => ({}), set_backup_schedule: () => undefined } as never;

export async function start_test_daemon(options: TestDaemonOptions = {}) {
  const profile = temp_folder("daemon");
  const database = new DatabaseSync(join(profile, "dev.db"));
  open_store(database);
  const changes = new EventStream();
  const announce = (): void => changes.announce_change();
  const store = bind_methods(() => database, announce);

  const stages = create_stage_files({ folder: join(profile, "stages") }).methods;
  stages.add_default_stages();
  const run_tools = create_run_tools({ database: () => database, after_write: announce, on_asked: (run_id) => runner.mark_asked(run_id) });
  await run_tools.start();
  const runner = create_runner({ database: () => database, stages, run_tools, folder: profile, after_write: announce });
  runner.methods.set_runner_setting("claude_program", fake_claude);
  runner.methods.set_runner_setting("gh_program", fake_gh);
  runner.methods.set_repository(repository, make_checkout());

  const remote = create_remote_access({
    profile,
    build: (admins, https) => build_app({ database, declared: admins, web_folder: "/nonexistent", backups: no_backups, stages, changes, runner: runner.methods, ...(https ? { https } : {}) }),
  });
  await remote.methods.set_remote_admin(admin.name, admin.password);
  const status = await remote.methods.set_remote_access({ enabled: true, host: "127.0.0.1", port: await free_port(), certificate_file: options.https?.certificate_file ?? "", key_file: options.https?.key_file ?? "" });
  if (!status.listening) throw new Error(`the test daemon did not listen: ${status.problem}`);

  return {
    profile,
    database,
    store,
    changes,
    runner,
    address: status.listening,
    stop: async () => {
      runner.stop_current();
      await runner.idle();
      await remote.stop();
      await run_tools.stop();
      database.close();
    },
  };
}
