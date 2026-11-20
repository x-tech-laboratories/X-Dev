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
import { calls_under, register_accounts } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import type { Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import type { BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import { register_sync_routes } from "@x-tech-laboratories/x-libs/server/sync_routes";
import { register_web_folder } from "@x-tech-laboratories/x-libs/server/web_folder";
import { register_webhook_route } from "@x-tech-laboratories/x-libs/server/forge_webhook";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { RunnerMethods } from "../shared/runs/runner.ts";
import { runner_api } from "../shared/runs/api.ts";
import { stages_api } from "../shared/stages/api.ts";
import { webhooks_api } from "../shared/webhooks/api.ts";
import type { StagesMethods } from "../shared/stages/model.ts";
import { webhook_path } from "../shared/webhooks/model.ts";

import { mcp_instructions as instructions } from "../shared/mcp.ts";
import { dev_api, is_read_only, sync_engine } from "../shared/store.ts";
import { register_dev_calls } from "./calls.ts";
import type { GitHubWebhooks } from "./github_webhooks.ts";
import { create_mcp_call, is_admin_tool, mcp_api } from "./mcp_calls.ts";
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
  // GitHub's webhooks: deliveries taken without a session, checked by their signature, and an admin's calls.
  webhooks?: Pick<GitHubWebhooks, "methods" | "receive">;
  // The certificate and key to serve https with; plain http without them.
  https?: { cert: Buffer; key: Buffer };
}

export interface Abilities {
  // Whether this daemon runs agents and the one asking may start them.
  runner: boolean;
  // Whether the one asking may read and change the stage files.
  stages: boolean;
  // Whether this host takes GitHub's webhooks and the one asking may set them up.
  webhooks?: boolean;
}

// ── Other programs ───────────────────────────────────────────────────────────

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// The narrower tokens Your account offers: one that files items for another session and starts nothing.
export const token_scopes = {
  add_items: { label: "Add items", hint: "Reads everything and adds items with add_item, opening their issues; starts no run and edits no item.", calls: ["add_item"] },
};

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: AppOptions): Promise<FastifyInstance> {
  const app = fastify({ forceCloseConnections: true, ...(options.https ? { https: options.https } : {}) } as FastifyServerOptions);
  register_lenient_json_body(app);
  register_error_replies(app);
  // A phone's page calls from an origin of its own with a token, the sign-in included, and a browser sends no cookie across origins.
  await register_open_cors(app);
  const accounts = new AccountStore({ database: options.database, app_name: "X-Dev", declared: options.declared, token_prefix: "xf", token_scopes });
  const admin = { role: accounts.top_role };
  // Backups hold the accounts, stages steer agents and the runner starts them with this computer's rights: admins only.
  const admin_only = ["/api/backup/", "/api/stages/", "/api/runner/", "/api/github_webhook/"];
  // GitHub posts without a session; its signature over the body is what lets a delivery in.
  const open_paths = options.webhooks ? [webhook_path] : [];
  await register_accounts(app, {
    accounts,
    cookie_name: "x_dev_session",
    open_paths,
    read_only_paths: ["/api/mcp"],
    needed: (_method, path) => (admin_only.some((prefix) => path.startsWith(prefix)) ? admin : "any"),
    // A read-only or scoped token may POST the calls that read, and its scope's, under the tables MCP also serves.
    call_of: calls_under("/api/call", "/api/runner", "/api/stages"),
    is_read_only,
  });

  const changes = options.changes ?? new EventStream();
  const database = () => options.database;
  const mcp_call = create_mcp_call({ database, announce: () => changes.announce_change(), stages: options.stages, runner: options.runner, webhooks: options.webhooks?.methods });

  await app.register(
    async (api) => {
      changes.register(api, "/events");

      register_dev_calls(api, database, changes);

      // What the page may offer, so a browser shows Run and the stage settings only where they work.
      api.get("/abilities", async (request): Promise<Abilities> => {
        const is_admin = request.viewer !== null && accounts.has_role(request.viewer.role, accounts.top_role);
        return { runner: options.runner !== undefined && is_admin, stages: is_admin, webhooks: options.webhooks !== undefined && is_admin };
      });

      const specs = { ...dev_api, ...stages_api, ...(options.runner ? runner_api : {}), ...(options.webhooks ? webhooks_api : {}) };
      const path_of = (method: string) => (method in stages_api ? `/api/stages/${method}` : method in runner_api ? `/api/runner/${method}` : method in webhooks_api ? `/api/github_webhook/${method}` : `/api/call/${method}`);
      api.get("/openapi.json", async () => openapi_document(specs, { title: "X-Dev", version, description: instructions, path_of, is_read_only }));

      // A change made through MCP is announced to every page, since no page made it.
      await register_mcp_route(api, {
        name: "x-dev",
        version,
        instructions,
        api: mcp_api(options.runner !== undefined, options.webhooks !== undefined),
        is_read_only,
        // The stage and runner tools need an admin, as their routes do.
        call: async (method, args, request) => {
          if (is_admin_tool(method) && !(request.viewer !== null && accounts.has_role(request.viewer.role, accounts.top_role))) throw new Error(`${method} needs an admin's token`);
          return mcp_call(method, args);
        },
      });

      // Backup calls arrive as POST /api/backup/<method> with the arguments as a JSON list.
      register_call_table(api, "/backup", options.backups, { is_read_only });
      // A stage file changed by an admin, or in another program, reaches every page.
      register_call_table(api, "/stages", options.stages, { is_read_only, on_change: (client_id) => changes.announce_change(client_id) });
      // Runner calls answer here only on a daemon that runs agents; the run tools' own server stays on 127.0.0.1.
      if (options.runner) register_call_table(api, "/runner", remote_runner(options.runner), { is_read_only, on_change: (client_id) => changes.announce_change(client_id) });
      // An admin sets the webhook up here; the secret leaves only through show_github_webhook_setup.
      if (options.webhooks) register_call_table(api, "/github_webhook", options.webhooks.methods, { is_read_only });
      register_sync_routes(api, {
        engine: sync_engine,
        database,
        back_up: async () => void (await options.backups.create_backup()),
        on_change: (request) => changes.announce_change(changes.client_id_of(request)),
      });
    },
    { prefix: "/api" },
  );

  if (options.webhooks) {
    const webhooks = options.webhooks;
    await register_webhook_route(app, { path: webhook_path, receive: (address, headers, body) => webhooks.receive(address, headers, body) });
  }
  await register_web_folder(app, { folder: options.web_folder });
  return app;
}
