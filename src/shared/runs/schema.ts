// The runs table, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, integer, real, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

import { items } from "../items/schema.ts";

// ── Tables ───────────────────────────────────────────────────────────────────

// One stage run on one item: what it was given, what the agent did, and the report it handed on.
export const runs = sqliteTable(
  "runs",
  {
    id: text().primaryKey(),
    item_id: text()
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    stage: text().notNull(),
    // "running", "waiting", "done", "failed", "stopped" or "discarded".
    state: text().notNull(),
    model: text().notNull().default(""),
    effort: text().notNull().default(""),
    // The agent's session, which a run waiting for answers resumes.
    session_id: text().notNull(),
    // The commit the item's worktree was on when the run started, which Discard resets it to.
    start_commit: text().notNull().default(""),
    // The status sheet as it was when the run started, which Discard puts back.
    status_before: text().notNull().default("{}"),
    input: text().notNull().default(""),
    // What the agent said and did, for the user; never handed to another agent.
    output: text().notNull().default(""),
    report: text().notNull().default(""),
    // The stage the report names next, "done", or "needs-input".
    next: text().notNull().default(""),
    // The questions asked through ask_user as JSON, and the user's answers.
    questions: text().notNull().default("[]"),
    answers: text().notNull().default(""),
    cost_usd: real().notNull().default(0),
    error: text().notNull().default(""),
    started_at: text().notNull(),
    ended_at: text(),
    // How many proposals the run made.
    proposals: integer().notNull().default(0),
    // The commit the worktree was on when the run ended, which later gates compare against.
    end_commit: text().notNull().default(""),
    // Each gate's result as JSON, and the user's overrides of failed ones with their reasons.
    gates: text().notNull().default("[]"),
    overrides: text().notNull().default("[]"),
    // The tokens the agent read, cached ones included, and wrote, summed over every turn of the run.
    input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    // The steps the agent took as JSON, for the live view and its replay; never handed to another agent.
    transcript: text().notNull().default(""),
    // What the user wrote to the session while it ran, as JSON.
    interjections: text().notNull().default("[]"),
    // The run this one retries, and which attempt at its stage it is.
    retry_of: text().notNull().default(""),
    attempt: integer().notNull().default(1),
    // The run's permission mode, the rules allowed for the whole run as JSON, and the tool waiting for approval.
    permission_mode: text().notNull().default(""),
    allowed: text().notNull().default("[]"),
    awaiting: text().notNull().default(""),
    // The files marked reviewed, each with the fingerprint of the content seen, and the files put back, as JSON.
    reviewed: text().notNull().default("{}"),
    reverts: text().notNull().default("[]"),
  },
  (table) => [index("runs_by_item").on(table.item_id, table.started_at)],
);

// Parents first, as sync applies them.
export const runs_tables = [runs];
