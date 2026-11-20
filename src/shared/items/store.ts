// Items: each feature or bug fix X-Dev takes through the stages, with the stage it is at and its status sheet.

// ── Imports ──────────────────────────────────────────────────────────────────

import { desc, eq, isNull, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { items_api } from "./api.ts";
import { migrations } from "./migrations/index.ts";
import { check_item, merge_status, read_status, type Item, type ItemInput, type ItemKind } from "./model.ts";
import { items, items_tables } from "./schema.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

type ItemRow = typeof items.$inferSelect;

function as_item(row: ItemRow): Item {
  return { ...row, kind: row.kind as ItemKind, status: read_status(row.status) };
}

function find_item(database: SqlDatabase, id: string): Item {
  const row = drizzle_of(database).select().from(items).where(eq(items.id, id)).get();
  if (!row) throw new Error(`no item ${id}`);
  return as_item(row);
}

// ── Store ────────────────────────────────────────────────────────────────────

export const items_feature = define_feature({
  id: "items",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(items_tables),
  methods: {
    list_items: (database: SqlDatabase, include_closed = false): Item[] => {
      const query = drizzle_of(database).select().from(items);
      const rows = include_closed ? query.orderBy(desc(items.created_at)).all() : query.where(isNull(items.closed_at)).orderBy(desc(items.created_at)).all();
      return rows.map(as_item);
    },
    get_item: (database: SqlDatabase, id: string): Item => find_item(database, id),
    save_item: (database: SqlDatabase, input: ItemInput, now = new Date().toISOString()): string => {
      const { id, ...fields } = check_item(input);
      if (id) {
        find_item(database, id);
        drizzle_of(database).update(items).set(fields).where(eq(items.id, id)).run();
        return id;
      }
      const created = new_id();
      drizzle_of(database).insert(items).values({ id: created, ...fields, created_at: now }).run();
      return created;
    },
    update_item_status: (database: SqlDatabase, id: string, changes: Partial<Record<string, string>>): void => {
      const status = merge_status(find_item(database, id).status, changes);
      drizzle_of(database).update(items).set({ status: JSON.stringify(status) }).where(eq(items.id, id)).run();
    },
    close_item: (database: SqlDatabase, id: string, now = new Date().toISOString()): void => {
      find_item(database, id);
      drizzle_of(database).update(items).set({ closed_at: now }).where(eq(items.id, id)).run();
    },
    reopen_item: (database: SqlDatabase, id: string): void => {
      find_item(database, id);
      drizzle_of(database).update(items).set({ closed_at: null }).where(eq(items.id, id)).run();
    },
    delete_item: (database: SqlDatabase, id: string): void => {
      find_item(database, id);
      drizzle_of(database).delete(items).where(eq(items.id, id)).run();
    },
  },
  api: items_api,
});
