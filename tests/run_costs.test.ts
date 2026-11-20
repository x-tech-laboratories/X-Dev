import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { gate_marks, gate_verdict, path_marks, read_stream_line, review_model_warning, sum_runs_by, tokens_of_usage } from "../src/shared/runs/model.ts";
import { add_run_tokens, insert_run, update_run } from "../src/shared/runs/store.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

function open_methods() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return { database, store: bind_methods(() => database, () => undefined) };
}

function add_run(database: DatabaseSync, item_id: string, stage: string, model: string, started_at: string) {
  return insert_run(database, { item_id, stage, model, effort: "", session_id: "s", start_commit: "", status_before: "{}", input: "", started_at });
}

// ============================================================================
// Tokens
// ============================================================================

describe("a run's tokens", () => {
  it("count cached input with the rest, and read nothing odd as tokens", () => {
    expect(tokens_of_usage({ input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 })).toEqual({ input: 115, output: 7 });
    expect(tokens_of_usage({ input_tokens: "lots" })).toEqual({ input: 0, output: 0 });
    expect(tokens_of_usage(undefined)).toEqual({ input: 0, output: 0 });
  });

  it("come from the result line of the agent's stream", () => {
    const line = JSON.stringify({ type: "result", result: "Done.", total_cost_usd: 0.1, session_id: "s", usage: { input_tokens: 3, output_tokens: 4 } });
    expect(read_stream_line(line).result?.tokens).toEqual({ input: 3, output: 4 });
  });

  it("add up over each turn of a run", () => {
    const { database, store } = open_methods();
    const id = store.save_item({ title: "Runs page", repository: "x-tech-laboratories/X-Dev" });
    const run_id = add_run(database, id, "plan", "fable", "2026-11-20T10:00:00.000Z");

    add_run_tokens(database, run_id, { input: 100, output: 10 });
    add_run_tokens(database, run_id, { input: 50, output: 5 });
    add_run_tokens(database, run_id, undefined);

    expect(store.get_run(run_id)).toMatchObject({ input_tokens: 150, output_tokens: 15 });
  });
});

// ============================================================================
// The Runs page
// ============================================================================

describe("the runs across items", () => {
  it("list every run newest first with its item, tokens, cost and gates, and no transcript", () => {
    const { database, store } = open_methods();
    const id = store.save_item({ title: "Runs page", repository: "x-tech-laboratories/X-Dev" });
    const first = add_run(database, id, "plan", "fable", "2026-11-20T10:00:00.000Z");
    const second = add_run(database, id, "implement", "opus", "2026-11-20T11:00:00.000Z");
    update_run(database, second, {
      state: "failed",
      output: "a long transcript",
      cost_usd: 1.5,
      input_tokens: 1000,
      output_tokens: 200,
      gates: [
        { gate: "tests-pass", outcome: "failed", findings: [] },
        { gate: "leftovers", outcome: "failed", findings: [] },
        { gate: "size", outcome: "skipped", findings: [] },
        { gate: "commits", outcome: "passed", findings: [] },
      ],
      overrides: [{ gate: "leftovers", reason: "known" }],
    });

    const summaries = store.list_run_summaries();

    expect(summaries.map((run) => run.id)).toEqual([second, first]);
    expect(summaries[0]).toMatchObject({ item_title: "Runs page", repository: "x-tech-laboratories/X-Dev", stage: "implement", model: "opus", state: "failed", cost_usd: 1.5, input_tokens: 1000, output_tokens: 200, gates_failed: 2, gates_passed_over: 1, gates_run: 3 });
    expect(summaries[0]).not.toHaveProperty("output");
    expect(gate_verdict(summaries[0]!)).toBe("failed");
    expect(gate_verdict(summaries[1]!)).toBe("none");
  });

  it("sum tokens and cost by stage and by model, the costliest first", () => {
    const run = (stage: string, model: string, cost_usd: number, tokens: number) => ({ stage, model, cost_usd, input_tokens: tokens, output_tokens: 0 });
    const runs = [run("plan", "fable", 0.5, 100), run("implement", "opus", 2, 1000), run("implement", "opus", 1, 500), run("review", "", 0.25, 50)];

    expect(sum_runs_by(runs, "stage")).toEqual([
      { key: "implement", runs: 2, tokens: 1500, cost_usd: 3 },
      { key: "plan", runs: 1, tokens: 100, cost_usd: 0.5 },
      { key: "review", runs: 1, tokens: 50, cost_usd: 0.25 },
    ]);
    expect(sum_runs_by(runs, "model").map((total) => total.key)).toEqual(["opus", "fable", "default"]);
  });

  it("read a gate passed over as such, and all passed as passed", () => {
    expect(gate_verdict({ gates_failed: 1, gates_passed_over: 1, gates_run: 4 })).toBe("passed over");
    expect(gate_verdict({ gates_failed: 0, gates_passed_over: 0, gates_run: 4 })).toBe("passed");
  });
});

// ============================================================================
// Models
// ============================================================================

describe("Review's model", () => {
  const runs = [
    { stage: "implement", model: "fable", state: "discarded" as const, started_at: "2026-11-20T12:00:00.000Z" },
    { stage: "implement", model: "opus", state: "done" as const, started_at: "2026-11-20T11:00:00.000Z" },
  ];

  it("is warned about when it is the model Implement's last run used", () => {
    expect(review_model_warning("review", "Opus", runs)).toContain("Implement's last run used opus");
  });

  it("is not warned about on another model, another stage, or with no Implement run", () => {
    expect(review_model_warning("review", "fable", runs)).toBe("");
    expect(review_model_warning("plan", "opus", runs)).toBe("");
    expect(review_model_warning("review", "opus", [])).toBe("");
    expect(review_model_warning("review", "", runs)).toBe("");
  });
});

// ============================================================================
// The board
// ============================================================================

describe("an item's path through the stages", () => {
  it("marks each stage done, failed, skipped, current or ahead", () => {
    const stages = ["triage", "plan", "specify", "implement", "review"];
    const runs = [
      { stage: "triage", state: "done" as const },
      { stage: "specify", state: "failed" as const },
      { stage: "review", state: "done" as const },
    ];
    expect(path_marks(stages, "implement", runs).map((each) => each.mark)).toEqual(["done", "skipped", "failed", "current", "ahead"]);
    expect(path_marks(stages, "specify", runs).map((each) => each.mark)).toEqual(["done", "skipped", "failed", "ahead", "ahead"]);
    expect(path_marks(stages, "done", runs).map((each) => each.mark)).toEqual(["done", "skipped", "failed", "skipped", "done"]);
  });

  it("shows each gate that ran, and which failed ones were passed over", () => {
    expect(
      gate_marks(
        [
          { gate: "tests-pass", outcome: "failed", findings: [] },
          { gate: "size", outcome: "skipped", findings: [] },
        ],
        [{ gate: "tests-pass", reason: "flaky" }],
      ),
    ).toEqual([{ gate: "tests-pass", outcome: "failed", passed_over: true }]);
  });

  it("gives each stage's latest run with its model, cost, gates and questions", () => {
    const { database, store } = open_methods();
    const id = store.save_item({ title: "Runs page", repository: "x-tech-laboratories/X-Dev", stage: "plan" });
    const run_id = add_run(database, id, "plan", "fable", "2026-11-20T10:00:00.000Z");
    update_run(database, run_id, { state: "waiting", cost_usd: 0.3, questions: [{ question: "Which?", why: "", choices: ["A", "B"] }] });

    expect(store.list_stage_runs()).toEqual([
      expect.objectContaining({ run_id, model: "fable", cost_usd: 0.3, state: "waiting", gates: [], questions: [{ question: "Which?", why: "", choices: ["A", "B"] }] }),
    ]);
  });

  it("sends an item back to another stage, unless it is closed, a proposal, or running", () => {
    const { database, store } = open_methods();
    const id = store.save_item({ title: "Runs page", repository: "x-tech-laboratories/X-Dev", stage: "implement" });

    store.send_item_back(id, "plan");
    expect(store.get_item(id).stage).toBe("plan");

    expect(() => store.send_item_back(id, " ")).toThrow("name the stage");
    const run_id = add_run(database, id, "plan", "fable", "2026-11-20T10:00:00.000Z");
    expect(() => store.send_item_back(id, "triage")).toThrow("under way");
    update_run(database, run_id, { state: "done" });
    store.close_item(id);
    expect(() => store.send_item_back(id, "triage")).toThrow("closed");
    const proposal = store.save_item({ title: "An idea", repository: "x-tech-laboratories/X-Dev", stage: "proposed" });
    expect(() => store.send_item_back(proposal, "triage")).toThrow("inbox");
  });
});
