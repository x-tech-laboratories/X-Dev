// Runs: every stage run on every item with its transcript and report, the notes handed to the next run, and the
// proposals runs make, which wait in the inbox until the user takes or drops them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, desc, eq, inArray, isNull, ne, or, sql, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { check_item, proposed, read_status, title_likeness, type Item, type ItemInput, type ItemKind } from "../items/model.ts";
import { items } from "../items/schema.ts";
import { runs_api } from "./api.ts";
import { can_retry } from "./attempts.ts";
import { migrations } from "./migrations/index.ts";
import { gates_cleared, type GateOverride, type GateResult } from "../gates/model.ts";
import { gate_marks, needs_input, report_summary, type Interjection, type Question, type Run, type RunState, type RunSummary, type StageRun, type TokenCounts } from "./model.ts";
import type { RunSnapshot } from "./notices.ts";
import { runs, runs_tables } from "./schema.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

type RunRow = typeof runs.$inferSelect;
type ItemRow = typeof items.$inferSelect;

function as_run(row: RunRow): Run {
  return {
    ...row,
    state: row.state as RunState,
    questions: JSON.parse(row.questions) as Question[],
    gates: JSON.parse(row.gates) as GateResult[],
    overrides: JSON.parse(row.overrides) as GateOverride[],
    interjections: JSON.parse(row.interjections) as Interjection[],
  };
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

export type RunStart = Pick<Run, "item_id" | "stage" | "model" | "effort" | "session_id" | "start_commit" | "status_before" | "input" | "started_at"> & Partial<Pick<Run, "retry_of" | "attempt">>;

export function insert_run(database: SqlDatabase, start: RunStart): string {
  const id = new_id();
  drizzle_of(database)
    .insert(runs)
    .values({ id, ...start, state: "running" })
    .run();
  return id;
}

export type RunChanges = Partial<Omit<Run, "id" | "item_id" | "questions" | "gates" | "overrides" | "interjections">> & { questions?: Question[]; gates?: GateResult[]; overrides?: GateOverride[]; interjections?: Interjection[] };

export function update_run(database: SqlDatabase, id: string, changes: RunChanges): void {
  const { questions, gates, overrides, interjections, ...rest } = changes;
  const as_json = (field: string, value: unknown) => (value ? { [field]: JSON.stringify(value) } : {});
  drizzle_of(database)
    .update(runs)
    .set({ ...rest, ...as_json("questions", questions), ...as_json("gates", gates), ...as_json("overrides", overrides), ...as_json("interjections", interjections) })
    .where(eq(runs.id, id))
    .run();
}

export function set_item_fields(database: SqlDatabase, id: string, changes: Partial<Pick<ItemRow, "stage" | "branch" | "status" | "notes" | "body" | "closed_at" | "issue_number">>): void {
  drizzle_of(database).update(items).set(changes).where(eq(items.id, id)).run();
}

// Adds the tokens one turn of a run's session used to the run's own.
export function add_run_tokens(database: SqlDatabase, id: string, tokens: TokenCounts | undefined): void {
  if (!tokens) return;
  drizzle_of(database)
    .update(runs)
    .set({ input_tokens: sql`${runs.input_tokens} + ${tokens.input}`, output_tokens: sql`${runs.output_tokens} + ${tokens.output}` })
    .where(eq(runs.id, id))
    .run();
}

// A run whose report is good and whose failed gates are all overridden hands its report on, moving the item on.
export function finish_run(database: SqlDatabase, run: Run): void {
  update_run(database, run.id, { state: "done", error: "" });
  set_item_fields(database, run.item_id, { notes: "", ...(run.next === needs_input ? {} : { stage: run.next }) });
}

// What the Runs page reads of each run, its transcript and input left behind.
const summary_columns = {
  id: runs.id,
  item_id: runs.item_id,
  item_title: items.title,
  repository: items.repository,
  stage: runs.stage,
  model: runs.model,
  state: runs.state,
  started_at: runs.started_at,
  ended_at: runs.ended_at,
  input_tokens: runs.input_tokens,
  output_tokens: runs.output_tokens,
  cost_usd: runs.cost_usd,
  gates: runs.gates,
  overrides: runs.overrides,
  error: runs.error,
  attempt: runs.attempt,
};

type SummaryRow = Omit<RunSummary, "state" | "gates_failed" | "gates_passed_over" | "gates_run"> & { state: string; gates: string; overrides: string };

function summary_of({ gates, overrides, ...row }: SummaryRow): RunSummary {
  const results = JSON.parse(gates) as GateResult[];
  const failed = results.filter((result) => result.outcome === "failed").map((result) => result.gate);
  return {
    ...row,
    state: row.state as RunState,
    gates_failed: failed.length,
    gates_passed_over: (JSON.parse(overrides) as GateOverride[]).filter((override) => failed.includes(override.gate)).length,
    gates_run: results.filter((result) => result.outcome !== "skipped").length,
  };
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
    list_stage_runs: (database: SqlDatabase): StageRun[] => {
      const rows = drizzle_of(database)
        .select({
          item_id: runs.item_id,
          stage: runs.stage,
          run_id: runs.id,
          state: runs.state,
          model: runs.model,
          report: runs.report,
          error: runs.error,
          started_at: runs.started_at,
          ended_at: runs.ended_at,
          cost_usd: runs.cost_usd,
          gates: runs.gates,
          overrides: runs.overrides,
          questions: runs.questions,
          attempt: runs.attempt,
        })
        .from(runs)
        .where(ne(runs.state, "discarded"))
        .orderBy(desc(runs.started_at))
        .all();
      const latest = new Map<string, StageRun>();
      for (const row of rows) {
        const key = `${row.item_id} ${row.stage}`;
        if (latest.has(key)) continue;
        const { report, gates, overrides, questions, ...rest } = row;
        const results = JSON.parse(gates) as GateResult[];
        const passed_over = JSON.parse(overrides) as GateOverride[];
        const state = row.state as RunState;
        latest.set(key, { ...rest, state, summary: report_summary(report), gates: gate_marks(results, passed_over), questions: JSON.parse(questions) as Question[], retryable: can_retry({ state, gates: results, overrides: passed_over }) });
      }
      return [...latest.values()];
    },
    list_run_summaries: (database: SqlDatabase): RunSummary[] =>
      drizzle_of(database)
        .select(summary_columns)
        .from(runs)
        .innerJoin(items, eq(items.id, runs.item_id))
        .orderBy(desc(runs.started_at))
        .all()
        .map(summary_of),
    // The runs under way and the ones named, as notices compare them from one change to the next.
    list_watched_runs: (database: SqlDatabase, run_ids: string[]): RunSnapshot[] => {
      const named = [...new Set(run_ids)];
      const under_way = eq(runs.state, "running");
      return drizzle_of(database)
        .select({ id: runs.id, item_id: runs.item_id, item_title: items.title, stage: runs.stage, state: runs.state, proposals: runs.proposals, report: runs.report, error: runs.error, questions: runs.questions })
        .from(runs)
        .innerJoin(items, eq(items.id, runs.item_id))
        .where(named.length ? or(under_way, inArray(runs.id, named)) : under_way)
        .all()
        .map(({ report, questions, ...row }) => ({ ...row, state: row.state as RunState, summary: report_summary(report), question: (JSON.parse(questions) as Question[])[0]?.question ?? "" }));
    },
    list_recent_runs: (database: SqlDatabase, limit: number): Run[] => drizzle_of(database).select().from(runs).orderBy(desc(runs.started_at)).limit(limit).all().map(as_run),
    update_run_report: (database: SqlDatabase, id: string, report: string): void => {
      const run = find_run(database, id);
      if (run.state !== "done") throw new Error("only a finished run's report can be changed");
      update_run(database, id, { report: report.trim() });
    },
    override_gate: (database: SqlDatabase, run_id: string, gate: string, reason: string): void => {
      const run = find_run(database, run_id);
      if (!run.gates.some((result) => result.gate === gate && result.outcome === "failed")) throw new Error(`the ${gate} gate did not fail on that run`);
      if (!reason.trim()) throw new Error("say why the gate can be passed over");
      const overrides = [...run.overrides.filter((override) => override.gate !== gate), { gate, reason: reason.trim() }];
      // The next stage reads why each gate was passed over.
      const report = `${run.report}\n\n**Gate passed over:** ${gate}: ${reason.trim()}`;
      update_run(database, run_id, { overrides, report });
      if (run.state === "failed" && run.next && gates_cleared(run.gates, overrides)) finish_run(database, { ...run, overrides, report });
    },
    send_item_back: (database: SqlDatabase, item_id: string, stage: string): void => {
      const item = find_item(database, item_id);
      if (item.closed_at) throw new Error("that item is closed");
      if (item.stage === proposed) throw new Error("take the proposal from the inbox first");
      if (!stage.trim()) throw new Error("name the stage to send it back to");
      const busy = drizzle_of(database).select({ id: runs.id }).from(runs).where(and(eq(runs.item_id, item_id), eq(runs.state, "running"))).get();
      if (busy) throw new Error("a run on that item is under way; stop it first");
      set_item_fields(database, item_id, { stage: stage.trim() });
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
