// The X-Dev tools a running stage's agent gets: asking the user, reading and changing its item's status sheet, and
// proposing new items. They are a small HTTP server on this computer that the agent calls with curl, since Claude Code
// refuses a run's own MCP servers where a managed MCP config is present; each run reaches only its item by its token.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import fastify, { type FastifyInstance } from "fastify";
import { positional_args, type MethodSpec } from "@x-tech-laboratories/x-libs/api_spec";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { item_kinds, merge_status, read_status } from "../shared/items/model.ts";
import { check_questions } from "../shared/runs/model.ts";
import { find_run, propose, set_item_fields, update_run, type ProposalInput } from "../shared/runs/store.ts";

// ── Tools ────────────────────────────────────────────────────────────────────

const status_text = { type: "string", description: "The section's new text, replacing what it held." };

export const tool_specs: Record<string, MethodSpec> = {
  get_item_status: { description: "Your item's status sheet: Goal, Current state, Decisions, Constraints, Known problems, Open questions and Links.", params: [] },
  update_item_status: {
    description: "Replaces sections of your item's status sheet. Edit sections in place and keep the sheet short; never append a log.",
    params: [
      {
        name: "changes",
        schema: {
          type: "object",
          description: "The sections to replace, by key.",
          properties: Object.fromEntries(["goal", "current_state", "decisions", "constraints", "known_problems", "open_questions", "links"].map((key) => [key, status_text])),
          additionalProperties: false,
        },
      },
    ],
  },
  ask_user: {
    description:
      "Asks the user questions whose answers change your result and that neither the code, the status sheet nor the standards settle. After calling it, end your turn with one line saying you are waiting; you are resumed with the answers.",
    params: [
      {
        name: "questions",
        schema: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question." },
              why: { type: "string", description: "Why the answer matters." },
              choices: { type: "array", items: { type: "string" }, description: "Answers to pick from, when there are some." },
            },
            required: ["question"],
          },
        },
      },
    ],
  },
  propose_item: {
    description: "Proposes work outside your item's goal, such as a bug you noticed or an improvement, as a new item for the user's inbox, instead of doing it.",
    params: [
      { name: "title", schema: { type: "string", description: "What the work is, in a few words." } },
      { name: "why", schema: { type: "string", description: "Why it matters." } },
      { name: "kind", schema: { type: "string", enum: [...item_kinds], description: "feature or bug; feature when left out." }, optional: true },
      { name: "where", schema: { type: "string", description: "Where you saw it, such as files and lines." }, optional: true },
      { name: "repository", schema: { type: "string", description: "The repository as owner/name, when it is not your item's." }, optional: true },
    ],
  },
};

// ── Server ───────────────────────────────────────────────────────────────────

export interface RunGrant {
  run_id: string;
  item_id: string;
  // 0 for no limit.
  max_proposals: number;
}

export interface RunToolsOptions {
  database: () => SqlDatabase;
  // Runs after each change, so history records it and the pages hear of it.
  after_write: () => void;
  // Told when the agent asked the user, so its run waits once the agent ends its turn.
  on_asked: (run_id: string) => void;
}

export interface RunTools {
  // A token the run's agent sends with each call; the grant ends with revoke.
  grant: (grant: RunGrant) => string;
  revoke: (token: string) => void;
  url: () => string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export const run_token_header = "x-dev-run";

// How the agent calls the tools, added to every run's input so it holds whatever the stage file says.
export function tools_guide(): string {
  const tools = Object.entries(tool_specs)
    .map(([name, spec]) => `- \`${name}\`: ${spec.description} Arguments: ${spec.params.length ? spec.params.map((param) => `${param.name}${param.optional ? " (optional)" : ""}`).join(", ") : "none"}.`)
    .join("\n");
  return [
    "## X-Dev tools",
    "",
    "Call X-Dev's tools with curl; the address and your run's token are in your environment. Send the arguments by name as one JSON object:",
    "",
    "```sh",
    `curl -s -X POST "$X_DEV_RUN_URL/tool/update_item_status" -H "${run_token_header}: $X_DEV_RUN_TOKEN" -H "content-type: application/json" --data-binary @- <<'JSON'`,
    '{"changes": {"current_state": "Planned; the next stage builds the lanes."}}',
    "JSON",
    "```",
    "",
    "The answer is {\"result\": ...} or {\"error\": \"...\"}. The tools:",
    "",
    tools,
  ].join("\n");
}

export function create_run_tools({ database, after_write, on_asked }: RunToolsOptions): RunTools {
  const grants = new Map<string, RunGrant>();
  let app: FastifyInstance | null = null;
  let address = "";

  function call(method: string, args: unknown[], grant: RunGrant): unknown {
    const db = database();
    const item = () => db.prepare("SELECT status FROM items WHERE id = ?").get(grant.item_id) as { status: string } | undefined;
    if (method === "get_item_status") return read_status(item()?.status ?? "{}");
    if (method === "update_item_status") {
      const merged = merge_status(read_status(item()?.status ?? "{}"), (args[0] ?? {}) as Record<string, string>);
      set_item_fields(db, grant.item_id, { status: JSON.stringify(merged) });
      after_write();
      return "The status sheet is updated.";
    }
    if (method === "ask_user") {
      update_run(db, grant.run_id, { questions: check_questions(args[0]) });
      on_asked(grant.run_id);
      after_write();
      return "Your questions are with the user. End your turn now with one line saying you are waiting; you will be resumed with the answers.";
    }
    if (method === "propose_item") {
      const run = find_run(db, grant.run_id);
      if (grant.max_proposals > 0 && run.proposals >= grant.max_proposals) {
        throw new Error(`this run has made its ${grant.max_proposals} proposals; list the rest in your report`);
      }
      const [title, why, kind, where, repository] = args as [string, string, ProposalInput["kind"], string?, string?];
      const result = propose(db, { item_id: grant.item_id, run_id: grant.run_id }, { title, why, kind, where, repository });
      update_run(db, grant.run_id, { proposals: run.proposals + 1 });
      after_write();
      return result.joined ? "An open item already covered it, so your note was added to that item." : "Proposed; it waits in the user's inbox.";
    }
    throw new Error(`no tool ${method}`);
  }

  return {
    grant: (grant) => {
      const token = randomBytes(24).toString("hex");
      grants.set(token, grant);
      return token;
    },
    revoke: (token) => void grants.delete(token),
    url: () => address,
    start: async () => {
      app = fastify({ forceCloseConnections: true });
      // Each tool is POST /tool/<name> with its arguments by name as a JSON object; the answer is { result } or { error }.
      app.post<{ Params: { name: string } }>("/tool/:name", async (request, reply) => {
        const grant = grants.get(String(request.headers[run_token_header] ?? ""));
        if (!grant) return reply.code(403).send({ error: "this run has ended, or the token is wrong" });
        const spec = tool_specs[request.params.name];
        if (!spec) return reply.code(404).send({ error: `no tool ${request.params.name}; the tools are ${Object.keys(tool_specs).join(", ")}` });
        try {
          const args = positional_args(spec, (request.body ?? {}) as Record<string, unknown>);
          return { result: call(request.params.name, args, grant) };
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
      });
      // Only this computer's own programs reach it, and only with a run's token.
      await app.listen({ host: "127.0.0.1", port: 0 });
      const bound = app.server.address();
      address = typeof bound === "object" && bound ? `http://127.0.0.1:${bound.port}` : "";
    },
    stop: async () => {
      await app?.close();
      app = null;
    },
  };
}
