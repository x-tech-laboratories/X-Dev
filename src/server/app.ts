// The web server: the page, every data call the page makes, and the sync every device runs against, all on one database.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { openapi_document } from "@x-tech-laboratories/x-libs/api_spec";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { register_call_table } from "@x-tech-laboratories/x-libs/server/call_table";
import { register_open_cors } from "@x-tech-laboratories/x-libs/server/cors";
import { register_mcp_route } from "@x-tech-laboratories/x-libs/server/mcp";
import { register_error_replies, register_lenient_json_body } from "@x-tech-laboratories/x-libs/server/replies";
import { register_accounts } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import type { Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import type { BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import { register_sync_routes } from "@x-tech-laboratories/x-libs/server/sync_routes";
import { register_web_folder } from "@x-tech-laboratories/x-libs/server/web_folder";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { RunnerMethods } from "../shared/runs/runner.ts";
import { runner_api } from "../shared/runs/api.ts";
import { stages_api } from "../shared/stages/api.ts";
import type { StagesMethods } from "../shared/stages/model.ts";

import { dev_bridge } from "../shared/bridge.ts";
import { mcp_instructions as instructions, without_secrets } from "../shared/mcp.ts";
import { bind_methods, dev_api, is_read_only, sync_engine } from "../shared/store.ts";
import { register_dev_calls } from "./calls.ts";
import { remote_runner } from "./remote_runner.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface AppOptions {
  database: SqlDatabase;
  // The users from the accounts file, who are admins; others are added on the Users page.
  declared: Accounts;
  web_folder: string;
  // The database's backups, which an admin manages from the page; one is taken before a device's data replaces it.
  backups: BackupMethods;
  // The stage files the server's agents run, which only an admin may change.
  stages: StagesMethods;
  // The pages' event stream, given when something outside the server, such as a stage file, can change too.
  changes?: EventStream;
  // The runner, on a daemon that holds the checkouts and runs the agents; only an admin may reach it.
  runner?: RunnerMethods;
  // The certificate and key to serve https with; plain http without them.
  https?: { cert: Buffer; key: Buffer };
}

export interface Abilities {
  // Whether this daemon runs agents and the one asking may start them.
  runner: boolean;
  // Whether the one asking may read and change the stage files.
  stages: boolean;
}

// ── Other programs ───────────────────────────────────────────────────────────

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: AppOptions): Promise<FastifyInstance> {
  const app = fastify({ forceCloseConnections: true, ...(options.https ? { https: options.https } : {}) } as FastifyServerOptions);
  register_lenient_json_body(app);
  register_error_replies(app);
  // A phone's page calls from an origin of its own with a token, the sign-in included, and a browser sends no cookie across origins.
  await register_open_cors(app);
  const accounts = new AccountStore({ database: options.database, app_name: "X-Dev", declared: options.declared, token_prefix: "xf" });
  const admin = { role: accounts.top_role };
  // Backups reach the whole database, the accounts included, stages tell agents what to run, and the runner starts them
  // with this computer's rights, so only an admin may reach any of them.
  const admin_only = ["/api/backup/", "/api/stages/", "/api/runner/"];
  await register_accounts(app, { accounts, cookie_name: "x_dev_session", read_only_paths: ["/api/mcp"], needed: (_method, path) => (admin_only.some((prefix) => path.startsWith(prefix)) ? admin : "any") });

  const changes = options.changes ?? new EventStream();
  const database = () => options.database;

  await app.register(
    async (api) => {
      changes.register(api, "/events");

      register_dev_calls(api, database, changes);

      // What the page may offer, so a browser shows Run and the stage settings only where they work.
      api.get("/abilities", async (request): Promise<Abilities> => {
        const is_admin = request.viewer !== null && accounts.has_role(request.viewer.role, accounts.top_role);
        return { runner: options.runner !== undefined && is_admin, stages: is_admin };
      });

      const specs = { ...dev_api, ...stages_api, ...(options.runner ? runner_api : {}) };
      const path_of = (method: string) => (method in stages_api ? `/api/stages/${method}` : method in runner_api ? `/api/runner/${method}` : `/api/call/${method}`);
      api.get("/openapi.json", async () => openapi_document(specs, { title: "X-Dev", version, description: instructions, path_of, is_read_only }));

      // A change made through MCP is announced to every page, since no page made it.
      await register_mcp_route(api, {
        name: "x-dev",
        version,
        instructions,
        api: dev_api,
        is_read_only,
        call: async (method, args) => {
          const methods = bind_methods(database, () => changes.announce_change());
          return without_secrets(method, await dev_bridge.dispatch(methods, method, args));
        },
      });

      // Backup calls arrive as POST /api/backup/<method> with the arguments as a JSON list.
      register_call_table(api, "/backup", options.backups, { is_read_only });
      // A stage file changed by an admin, or in another program, reaches every page.
      register_call_table(api, "/stages", options.stages, { is_read_only, on_change: (client_id) => changes.announce_change(client_id) });
      // Runner calls answer here only on a daemon that runs agents; the run tools' own server stays on 127.0.0.1.
      if (options.runner) register_call_table(api, "/runner", remote_runner(options.runner), { is_read_only, on_change: (client_id) => changes.announce_change(client_id) });
      register_sync_routes(api, {
        engine: sync_engine,
        database,
        back_up: async () => void (await options.backups.create_backup()),
        on_change: (request) => changes.announce_change(changes.client_id_of(request)),
      });
    },
    { prefix: "/api" },
  );

  await register_web_folder(app, { folder: options.web_folder });
  return app;
}
