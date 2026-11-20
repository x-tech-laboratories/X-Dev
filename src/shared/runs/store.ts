// Runs: every stage run on every item with its transcript and report, the notes handed to the next run, and the
// proposals runs make, which wait in the inbox until the user takes or drops them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, desc, eq, isNull, ne, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { check_item, proposed, read_status, title_likeness, type Item, type ItemInput, type ItemKind } from "../items/model.ts";
import { items } from "../items/schema.ts";
import { runs_api } from "./api.ts";
import { migrations } from "./migrations/index.ts";
import type { Question, Run, RunState } from "./model.ts";
import { runs, runs_tables } from "./schema.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

type RunRow = typeof runs.$inferSelect;
type ItemRow = typeof items.$inferSelect;

function as_run(row: RunRow): Run {
  return { ...row, state: row.state as RunState, questions: JSON.parse(row.questions) as Question[] };
}

function as_item(row: ItemRow): Item {
  return { ...row, kind: row.kind as ItemKind, status: read_status(row.status) };
}

export function find_run(database: SqlDatabase, id: string): Run {
  const row = drizzle_of(database).select().from(runs).where(eq(runs.id, id)).get();
  if (!row) throw new Error(`no run ${id}`);
  return as_run(row);
}

function find_item(database: SqlDatabase, id: string): Item {
  const row = drizzle_of(database).select().from(items).where(eq(items.id, id)).get();
  if (!row) throw new Error(`no item ${id}`);
  return as_item(row);
}

// The report the next run starts from: the latest one a run handed on that the user did not discard.
export function latest_report(database: SqlDatabase, item_id: string): string {
  const row = drizzle_of(database)
    .select({ report: runs.report })
    .from(runs)
    .where(and(eq(runs.item_id, item_id), eq(runs.state, "done"), ne(runs.report, "")))
    .orderBy(desc(runs.started_at))
    .get();
  return row?.report ?? "";
}

export function runs_in_state(database: SqlDatabase, state: RunState): Run[] {
  return drizzle_of(database).select().from(runs).where(eq(runs.state, state)).all().map(as_run);
}

// ── Writing ──────────────────────────────────────────────────────────────────

export type RunStart = Pick<Run, "item_id" | "stage" | "model" | "effort" | "session_id" | "start_commit" | "status_before" | "input" | "started_at">;

export function insert_run(database: SqlDatabase, start: RunStart): string {
  const id = new_id();
  drizzle_of(database)
    .insert(runs)
    .values({ id, ...start, state: "running" })
    .run();
  return id;
}

export type RunChanges = Partial<Omit<Run, "id" | "item_id" | "questions">> & { questions?: Question[] };

export function update_run(database: SqlDatabase, id: string, changes: RunChanges): void {
  const { questions, ...rest } = changes;
  drizzle_of(database)
    .update(runs)
    .set({ ...rest, ...(questions ? { questions: JSON.stringify(questions) } : {}) })
    .where(eq(runs.id, id))
    .run();
}

export function set_item_fields(database: SqlDatabase, id: string, changes: Partial<Pick<ItemRow, "stage" | "branch" | "status" | "notes" | "body" | "closed_at" | "issue_number">>): void {
  drizzle_of(database).update(items).set(changes).where(eq(items.id, id)).run();
}

// ── Proposals ────────────────────────────────────────────────────────────────

export interface ProposalInput {
  title: string;
  kind?: ItemKind;
  repository?: string;
  why: string;
  // Where it was seen, such as files and lines.
  where?: string;
}

const same_idea_likeness = 0.6;

export interface ProposalResult {
  item_id: string;
  // Whether it was added to an item already open rather than made new.
  joined: boolean;
}

// A proposal from a run: added to an open item with a title close enough, or made as a new item waiting in the inbox.
export function propose(database: SqlDatabase, source: { item_id: string; run_id: string }, input: ProposalInput, now = new Date().toISOString()): ProposalResult {
  const source_item = find_item(database, source.item_id);
  const repository = input.repository?.trim() || source_item.repository;
  const why = input.why.trim();
  if (!why) throw new Error("say why the proposal matters");
  const note = [`Proposed from "${source_item.title}": ${why}`, input.where?.trim() ? `Seen in ${input.where.trim()}.` : ""].filter(Boolean).join(" ");
  const open = drizzle_of(database).select().from(items).where(and(eq(items.repository, repository), isNull(items.closed_at))).all();
  const same = open.find((row) => row.id !== source.item_id && title_likeness(row.title, input.title) >= same_idea_likeness);
  if (same) {
    set_item_fields(database, same.id, { body: `${same.body}${same.body ? "\n\n" : ""}${note}` });
    return { item_id: same.id, joined: true };
  }
  const checked = check_item({ title: input.title, kind: input.kind ?? "feature", repository, body: note, stage: proposed } satisfies ItemInput);
  const id = new_id();
  drizzle_of(database)
    .insert(items)
    .values({ ...checked, id, created_at: now, source_item_id: source.item_id, source_run_id: source.run_id })
    .run();
  return { item_id: id, joined: false };
}

// ── Store ────────────────────────────────────────────────────────────────────

export const runs_feature = define_feature({
  id: "runs",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(runs_tables),
  methods: {
    list_runs: (database: SqlDatabase, item_id: string): Run[] =>
      drizzle_of(database).select().from(runs).where(eq(runs.item_id, item_id)).orderBy(desc(runs.started_at)).all().map(as_run),
    get_run: (database: SqlDatabase, id: string): Run => find_run(database, id),
    list_recent_runs: (database: SqlDatabase, limit: number): Run[] => drizzle_of(database).select().from(runs).orderBy(desc(runs.started_at)).limit(limit).all().map(as_run),
    update_run_report: (database: SqlDatabase, id: string, report: string): void => {
      const run = find_run(database, id);
      if (run.state !== "done") throw new Error("only a finished run's report can be changed");
      update_run(database, id, { report: report.trim() });
    },
    save_item_notes: (database: SqlDatabase, item_id: string, notes: string): void => {
      find_item(database, item_id);
      set_item_fields(database, item_id, { notes: notes.trim() });
    },
    list_proposals: (database: SqlDatabase): Item[] =>
      drizzle_of(database)
        .select()
        .from(items)
        .where(and(eq(items.stage, proposed), isNull(items.closed_at)))
        .orderBy(desc(items.created_at))
        .all()
        .map(as_item),
    accept_proposal: (database: SqlDatabase, id: string): void => {
      if (find_item(database, id).stage !== proposed) throw new Error("that item is not a proposal");
      set_item_fields(database, id, { stage: "triage" });
    },
    drop_proposal: (database: SqlDatabase, id: string, now = new Date().toISOString()): void => {
      if (find_item(database, id).stage !== proposed) throw new Error("that item is not a proposal");
      set_item_fields(database, id, { closed_at: now });
    },
  },
  api: runs_api,
});
