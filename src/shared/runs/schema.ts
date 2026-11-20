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
  },
  (table) => [index("runs_by_item").on(table.item_id, table.started_at)],
);

// Parents first, as sync applies them.
export const runs_tables = [runs];
