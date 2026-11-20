// The run calls described for other programs: what each does and the arguments it takes.

// ── Imports ──────────────────────────────────────────────────────────────────

import { id_of, text } from "../api_schemas.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

export const runs_api = {
  list_runs: {
    description: "Lists an item's stage runs, newest first: the stage, its state (running, waiting, done, failed, stopped or discarded), the model, the report, any questions and the cost.",
    params: [{ name: "item_id", schema: id_of("item") }],
  },
  get_run: { description: "One run with its input, transcript and report.", params: [{ name: "id", schema: id_of("run") }] },
  list_recent_runs: {
    description: "Lists the latest runs across every item, newest first.",
    params: [{ name: "limit", schema: { type: "integer", minimum: 1, description: "How many runs at most." } }],
  },
  update_run_report: {
    description: "Replaces a finished run's report, which the item's next run starts from.",
    params: [{ name: "id", schema: id_of("run") }, { name: "report", schema: text("The whole report block.") }],
  },
  override_gate: {
    description: "Passes over a gate that failed on a run, with the reason, which is added to the run's report; once every failed gate is passed over, the item moves on to the stage the report names.",
    params: [{ name: "run_id", schema: id_of("run") }, { name: "gate", schema: text("The gate's name, such as leftovers.") }, { name: "reason", schema: text("Why it can be passed over.") }],
  },
  save_item_notes: {
    description: "Sets the notes the item's next run is handed, such as answers, corrections or a change of scope.",
    params: [{ name: "item_id", schema: id_of("item") }, { name: "notes", schema: text("The notes; empty for none.") }],
  },
  list_proposals: { description: "Lists the proposals runs made that wait in the inbox for the user.", params: [] },
  accept_proposal: { description: "Takes a proposal into the pipeline at Triage.", params: [{ name: "id", schema: id_of("proposal") }] },
  drop_proposal: { description: "Drops a proposal; it stays in the history.", params: [{ name: "id", schema: id_of("proposal") }] },
};
