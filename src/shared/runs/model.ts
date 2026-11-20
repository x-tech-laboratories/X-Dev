// What a run is, how its report is read, how its input is put together and how the agent's stream becomes a transcript,
// apart from the database and the agent, so every host and the tests share the rules.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { GateOverride, GateResult } from "../gates/model.ts";
import { status_sections, type Item } from "../items/model.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export const run_states = ["running", "waiting", "done", "failed", "stopped", "discarded"] as const;

export type RunState = (typeof run_states)[number];

export interface Question {
  question: string;
  why: string;
  choices: string[];
}

export interface Run {
  id: string;
  item_id: string;
  stage: string;
  state: RunState;
  model: string;
  effort: string;
  session_id: string;
  start_commit: string;
  status_before: string;
  input: string;
  output: string;
  report: string;
  next: string;
  questions: Question[];
  answers: string;
  cost_usd: number;
  error: string;
  started_at: string;
  ended_at: string | null;
  proposals: number;
  end_commit: string;
  gates: GateResult[];
  overrides: GateOverride[];
  input_tokens: number;
  output_tokens: number;
}

// A report's Next when the stage waits on the user.
export const needs_input = "needs-input";

// The most of a run's transcript kept, the newest part kept when it runs over.
export const output_limit = 300_000;

// ── Reports ──────────────────────────────────────────────────────────────────

export interface ParsedReport {
  // The whole block, from its heading to the end.
  text: string;
  next: string;
}

const report_heading = /^##\s+[^\n]*\bhandoff\s*$/gim;
const next_line = /^\*\*Next:\*\*\s*`?([a-z][a-z0-9-]*)`?/im;

// The last report block in an agent's final message, or null when it gave none or named no next stage.
export function parse_report(message: string): ParsedReport | null {
  const starts = [...message.matchAll(report_heading)].map((match) => match.index);
  const start = starts.at(-1);
  if (start === undefined) return null;
  const text = message.slice(start).trim();
  const next = next_line.exec(text)?.[1];
  return next ? { text, next } : null;
}

// One line saying what a run did, for a board's cell: the first of its report's Done items, else its first line.
export function report_summary(report: string): string {
  const done = /\*\*Done:\*\*\s*(?:\n\s*)?-?\s*([^\n]+)/.exec(report)?.[1]?.trim();
  if (done && done !== "-") return done.replace(/^-\s*/, "");
  return report.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
}

// One gate's result on a run as a card shows it, a failed one marked when the user passed it over.
export interface GateMark {
  gate: string;
  outcome: GateResult["outcome"];
  passed_over: boolean;
}

// The latest run of one stage on one item, as a board shows it.
export interface StageRun {
  item_id: string;
  stage: string;
  run_id: string;
  state: RunState;
  model: string;
  summary: string;
  error: string;
  started_at: string;
  ended_at: string | null;
  cost_usd: number;
  gates: GateMark[];
  questions: Question[];
}

// The gates a run went through, the ones that were not checked left out.
export function gate_marks(gates: GateResult[], overrides: GateOverride[]): GateMark[] {
  return gates.filter((result) => result.outcome !== "skipped").map((result) => ({ gate: result.gate, outcome: result.outcome, passed_over: overrides.some((override) => override.gate === result.gate) }));
}

// ── Input ────────────────────────────────────────────────────────────────────

export interface RunInputParts {
  item: Item;
  stage_label: string;
  worktree: string;
  issue_url: string | null;
  latest_report: string;
  notes: string;
}

// What a stage's agent is handed: the item, its status sheet, the latest report and the user's notes, and nothing else.
export function build_run_input({ item, stage_label, worktree, issue_url, latest_report, notes }: RunInputParts): string {
  const sheet = status_sections.map((section) => `### ${section.label}\n\n${item.status[section.key] || "Nothing yet."}`).join("\n\n");
  return [
    `You are running the ${stage_label} stage for this item.`,
    `# ${item.title}`,
    [
      `- Kind: ${item.kind}`,
      `- Repository: ${item.repository}`,
      `- Issue: ${issue_url ?? "none yet"}`,
      `- Worktree: ${worktree} (branch ${item.branch}); work only here`,
    ].join("\n"),
    `## What it asks for\n\n${item.body || "See the title."}`,
    `## Status sheet\n\n${sheet}`,
    `## Latest report\n\n${latest_report || "None; no stage has run yet."}`,
    `## Notes from the user\n\n${notes || "None."}`,
  ].join("\n\n");
}

// The user's answers, as the resumed session is handed them.
export function answers_input(questions: Question[], answers: string): string {
  const asked = questions.map((question, index) => `${index + 1}. ${question.question}`).join("\n");
  return `The user answered your questions.\n\nYou asked:\n${asked}\n\nTheir answers:\n${answers.trim()}\n\nCarry on with the stage, and end with the report block.`;
}

// ── Transcript ───────────────────────────────────────────────────────────────

export interface TokenCounts {
  input: number;
  output: number;
}

export interface StreamResult {
  text: string;
  is_error: boolean;
  cost_usd: number;
  session_id: string;
  tokens: TokenCounts;
}

// The tokens a result's usage names, cached input counted with the rest.
export function tokens_of_usage(usage: unknown): TokenCounts {
  const fields = (usage ?? {}) as Record<string, unknown>;
  const count = (key: string): number => (Number.isFinite(Number(fields[key])) ? Number(fields[key]) : 0);
  return { input: count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens"), output: count("output_tokens") };
}

// One line of the agent's stream-json output as transcript lines, and the run's result once it arrives.
export function read_stream_line(line: string): { lines: string[]; result: StreamResult | null } {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { lines: line.trim() ? [line.trim()] : [], result: null };
  }
  if (message.type === "result") {
    return {
      lines: [],
      result: { text: String(message.result ?? ""), is_error: message.is_error === true, cost_usd: Number(message.total_cost_usd) || 0, session_id: String(message.session_id ?? ""), tokens: tokens_of_usage(message.usage) },
    };
  }
  if (message.type !== "assistant") return { lines: [], result: null };
  const content = ((message.message as { content?: unknown } | undefined)?.content ?? []) as Record<string, unknown>[];
  const lines = content.flatMap((part) => {
    if (part.type === "text") return [String(part.text ?? "")];
    if (part.type === "tool_use") return [`→ ${String(part.name)}: ${describe_tool_input(part.input)}`];
    return [];
  });
  return { lines, result: null };
}

const tool_input_shown = 200;

function describe_tool_input(input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>;
  const main = fields.command ?? fields.file_path ?? fields.pattern ?? fields.url ?? fields.description ?? JSON.stringify(fields);
  const text = String(main).replace(/\s+/g, " ");
  return text.length > tool_input_shown ? `${text.slice(0, tool_input_shown)}…` : text;
}

// The transcript with more added, keeping the newest part once it is over the limit.
export function append_output(output: string, lines: string[]): string {
  if (!lines.length) return output;
  const joined = `${output}${output ? "\n" : ""}${lines.join("\n")}`;
  return joined.length > output_limit ? `…\n${joined.slice(joined.length - output_limit)}` : joined;
}

// ── Questions ────────────────────────────────────────────────────────────────

// Questions as an agent sends them, checked; an error in plain words otherwise.
export function check_questions(questions: unknown): Question[] {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error("ask at least one question");
  return questions.map((each, index) => {
    const fields = (each ?? {}) as Record<string, unknown>;
    const question = String(fields.question ?? "").trim();
    if (!question) throw new Error(`question ${index + 1} has no text`);
    const choices = Array.isArray(fields.choices) ? fields.choices.map(String).filter(Boolean) : [];
    return { question, why: String(fields.why ?? "").trim(), choices };
  });
}

// A short id for an item's branch and worktree: its issue number, or the start of its id.
export function branch_name_of(item: Item): string {
  return `worktree-item-${item.issue_number ?? item.id.slice(0, 8)}`;
}

// ── Costs ────────────────────────────────────────────────────────────────────

// One run as the Runs page lists it, without its transcript, with its item's title and how its gates went.
export interface RunSummary {
  id: string;
  item_id: string;
  item_title: string;
  repository: string;
  stage: string;
  model: string;
  state: RunState;
  started_at: string;
  ended_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  gates_failed: number;
  gates_passed_over: number;
  gates_run: number;
  error: string;
}

export interface CostTotal {
  key: string;
  runs: number;
  tokens: number;
  cost_usd: number;
}

// The runs' tokens and cost summed by their stage or model, the costliest first.
export function sum_runs_by(runs: Pick<RunSummary, "stage" | "model" | "input_tokens" | "output_tokens" | "cost_usd">[], field: "stage" | "model"): CostTotal[] {
  const totals = new Map<string, CostTotal>();
  for (const run of runs) {
    const key = run[field] || "default";
    const total = totals.get(key) ?? { key, runs: 0, tokens: 0, cost_usd: 0 };
    totals.set(key, { key, runs: total.runs + 1, tokens: total.tokens + run.input_tokens + run.output_tokens, cost_usd: total.cost_usd + run.cost_usd });
  }
  return [...totals.values()].sort((first, second) => second.cost_usd - first.cost_usd || second.tokens - first.tokens || first.key.localeCompare(second.key));
}

// How a gate result reads in one word: failed, passed over, passed, or none when no gate ran.
export function gate_verdict(run: Pick<RunSummary, "gates_failed" | "gates_passed_over" | "gates_run">): "failed" | "passed over" | "passed" | "none" {
  if (run.gates_run === 0) return "none";
  if (run.gates_failed > run.gates_passed_over) return "failed";
  return run.gates_failed > 0 ? "passed over" : "passed";
}

// ── Models ───────────────────────────────────────────────────────────────────

// The stage whose model Review should differ from, and the stage that checks it.
export const implement_stage = "implement";
export const review_stage = "review";

// Why a Review run on this model should be thought twice about, when Implement's last run used the same one; empty otherwise.
export function review_model_warning(stage: string, model: string, runs: Pick<Run, "stage" | "model" | "state" | "started_at">[]): string {
  if (stage !== review_stage || !model) return "";
  const implement = runs.filter((run) => run.stage === implement_stage && run.state !== "discarded").sort((first, second) => second.started_at.localeCompare(first.started_at))[0];
  if (!implement || implement.model.toLowerCase() !== model.toLowerCase()) return "";
  return `Implement's last run used ${implement.model} too; a review on a second model catches what the first one missed.`;
}

// ── Path ─────────────────────────────────────────────────────────────────────

export type PathMark = RunState | "skipped" | "current" | "ahead";

// Each stage as the item went through it: its latest run's state, skipped, current with no run yet, or ahead.
export function path_marks(stage_ids: string[], current: string, runs: Pick<StageRun, "stage" | "state">[]): { stage: string; mark: PathMark }[] {
  const at = current === "done" ? stage_ids.length : stage_ids.indexOf(current);
  return stage_ids.map((stage, index) => {
    const run = runs.find((each) => each.stage === stage);
    if (run && (index <= at || at < 0)) return { stage, mark: run.state };
    if (index === at) return { stage, mark: "current" };
    return { stage, mark: index < at ? "skipped" : "ahead" };
  });
}
