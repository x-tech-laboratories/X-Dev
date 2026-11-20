// Starts the X-Dev web server on the database the config names.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { keep_backing_up } from "@x-tech-laboratories/x-libs/backups";
import { read_server_config } from "@x-tech-laboratories/x-libs/server/config";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { load_accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";

import { dev_backup_naming, read_schedule } from "../shared/backups.ts";
import { needs_upgrade, open_store, sync_engine } from "../shared/store.ts";
import { build_app } from "./app.ts";
import { create_stage_files } from "./stage_files.ts";

// ── Config ───────────────────────────────────────────────────────────────────

interface DevConfig {
  database: string;
  backups_folder: string;
  // Claude Code's agents folder in the server's home unless set.
  stages_folder?: string;
}

const server_config = read_server_config({
  program: "x-dev",
  summary: "Serves X-Dev as a web app and syncs its devices.",
  env_prefix: "X_DEV",
  default_port: 7760,
  secret: false,
  web_folder_default: join(import.meta.dirname, "../../out/web"),
  options: { config: { variable: "X_DEV_CONFIG", help: "the JSON config naming the database and the backups folder", placeholder: "<file>", required: true } },
});

const config = JSON.parse(readFileSync(server_config.values.config!, "utf8")) as DevConfig;
const database_path = resolve(config.database);
const backups_folder = resolve(config.backups_folder);
const stages_folder = resolve(config.stages_folder ?? join(homedir(), ".claude", "agents"));

// ── Database ─────────────────────────────────────────────────────────────────

mkdirSync(dirname(database_path), { recursive: true });
// A backup restored from the page waits beside the database until the server starts again.
const restored = take_staged_restore(database_path);
const database = new DatabaseSync(database_path);
database.exec("PRAGMA journal_mode = WAL");

// ── Backups ──────────────────────────────────────────────────────────────────

const answer_delay_ms = 500;

// A restore is staged for the next start, then the server stops, once the page has its answer, so its service starts it
// again on the backup.
const kept = sqlite_backups({
  folder: () => {
    mkdirSync(backups_folder, { recursive: true });
    return backups_folder;
  },
  naming: dev_backup_naming,
  database: () => database,
  database_path: () => database_path,
  after_staging: () => void setTimeout(stop, answer_delay_ms),
});

if (needs_upgrade(database)) await kept.create();
open_store(database);
// The restored data is no longer what the devices last saw, so each chooses again which copy to keep.
if (restored) sync_engine.forget_history(database);

// The schedule belongs to this server, so it is kept beside the database rather than in the synced settings.
const schedule_file = join(dirname(database_path), "backup-schedule.json");
const read_backup_schedule = () => read_schedule(existsSync(schedule_file) ? JSON.parse(readFileSync(schedule_file, "utf8")) : null);
const backing_up = keep_backing_up(kept, read_backup_schedule);

// ── Stages ─────────────────────────────────────────────────────────────────

// A stage file changed in another program reaches every page.
const changes = new EventStream();
const stage_files = create_stage_files({ folder: stages_folder, on_change: () => changes.announce_change() });

// ── Server ───────────────────────────────────────────────────────────────────

const app = await build_app({
  database,
  declared: load_accounts("X_DEV_PASSWORD_HASH_FILE"),
  web_folder: server_config.web_folder,
  backups: {
    list_backups: kept.list,
    create_backup: () => kept.create(),
    restore_backup: kept.restore,
    remove_backup: kept.remove,
    get_backup_schedule: read_backup_schedule,
    set_backup_schedule: (schedule) => {
      writeFileSync(schedule_file, JSON.stringify(read_schedule(schedule), null, 2));
      void backing_up.check();
    },
  },
  stages: stage_files.methods,
  changes,
});
await app.listen({ host: server_config.host, port: server_config.port });
console.info(`X-Dev is serving http://${server_config.host}:${server_config.port}/`);

const stop_watching_stages = stage_files.watch();

function stop(): void {
  stop_watching_stages();
  backing_up.stop();
  void app.close().then(() => database.close());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
