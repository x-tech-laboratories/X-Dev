// What a run is, how its report is read, how its input is put together and how the agent's stream becomes a transcript,
// apart from the database and the agent, so every host and the tests share the rules.

// ── Imports ──────────────────────────────────────────────────────────────────

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

export interface StreamResult {
  text: string;
  is_error: boolean;
  cost_usd: number;
  session_id: string;
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
      result: { text: String(message.result ?? ""), is_error: message.is_error === true, cost_usd: Number(message.total_cost_usd) || 0, session_id: String(message.session_id ?? "") },
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
