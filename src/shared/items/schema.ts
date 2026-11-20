// The items tables, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, integer, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// One feature or bug fix in one repository, taken through the stages one run at a time.
export const items = sqliteTable(
  "items",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    // "feature" or "bug".
    kind: text().notNull().default("feature"),
    // The GitHub repository as owner/name, such as x-tech-laboratories/X-Dev.
    repository: text().notNull(),
    issue_number: integer(),
    // What the item asks for, as the issue's body would say it.
    body: text().notNull().default(""),
    // The stage the item is at, such as "plan"; "proposed" for a proposal waiting in the inbox, "done" after the last.
    stage: text().notNull().default("triage"),
    // The status sheet's sections as JSON, kept current by every stage.
    status: text().notNull().default("{}"),
    // What the user wants the next run to know, handed to it and then kept for the record.
    notes: text().notNull().default(""),
    // The git branch the item's worktree is on, set by its first run.
    branch: text().notNull().default(""),
    // The item and run that proposed it, for a proposal.
    source_item_id: text(),
    source_run_id: text(),
    created_at: text().notNull(),
    closed_at: text(),
    // The item's pull request as JSON, with its state and checks; empty before Review opens one.
    pull_request: text().notNull().default(""),
    // What X-Dev last mirrored to the issue as JSON: its labels, report comments and status sheet, and what failed.
    github: text().notNull().default("{}"),
  },
  (table) => [index("items_by_repository").on(table.repository)],
);

// Parents first, as sync applies them.
export const items_tables = [items];
