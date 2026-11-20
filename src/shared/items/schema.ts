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
    // The stage the item is at, such as "plan".
    stage: text().notNull().default("triage"),
    // The status sheet's sections as JSON, kept current by every stage.
    status: text().notNull().default("{}"),
    created_at: text().notNull(),
    closed_at: text(),
  },
  (table) => [index("items_by_repository").on(table.repository)],
);

// Parents first, as sync applies them.
export const items_tables = [items];
