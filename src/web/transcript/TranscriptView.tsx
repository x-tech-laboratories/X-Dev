// An agent's transcript as steps: thinking folded to one line, its text as markdown, each tool call as a row naming
// the tool and what it works on that opens to its whole input and result, an edit as a small diff, and the user's own
// messages in place, marked while the agent has not read them yet, and each tool call waiting for approval with Allow,
// Allow for this run and Deny. It follows the newest step until the reader scrolls up, with a button back to the latest.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { use_follow_tail } from "@x-tech-laboratories/x-libs/web/react/following";
import { Markdown } from "@x-tech-laboratories/x-libs/web/react/markdown";
import { cx } from "@x-tech-laboratories/x-libs/web/dom";

import { useState } from "react";

import { permission_rule, rule_words } from "../../shared/runs/modes.ts";
import { edit_of, tool_summary, type PermissionDecision, type PermissionEntry, type ThinkingEntry, type ToolEntry, type TranscriptEntry, type UserEntry, type UserRole } from "../../shared/runs/transcript.ts";
import { EditDiff } from "./EditDiff.tsx";

// ── Steps ────────────────────────────────────────────────────────────────────

const default_user_labels: Record<UserRole, string> = { input: "Input", interjection: "You", answers: "Your answers" };

function first_line(text: string): string {
  return text.trim().split("\n").at(-1)?.trim() ?? "";
}

function Thinking({ entry }: { entry: ThinkingEntry }) {
  return (
    <details className="transcript-step transcript-thinking">
      <summary>
        <span className={cx("status-dot", "tone-info", entry.streaming && "busy")} aria-hidden="true" /> <span className="muted">{entry.streaming ? "Thinking…" : "Thought"}</span> <span className="transcript-line muted small">{first_line(entry.text)}</span>
      </summary>
      <p className="transcript-text muted">{entry.text || "The model kept its thinking to itself."}</p>
    </details>
  );
}

function ToolInput({ name, input, input_text }: { name: string; input: Record<string, unknown>; input_text?: string }) {
  if (input_text !== undefined) return <pre className="transcript-code">{input_text}</pre>;
  const edits = edit_of(name, input);
  if (edits) return <>{edits.map((edit, index) => <EditDiff key={index} {...edit} />)}</>;
  if (typeof input.command === "string") return <pre className="transcript-code">{input.command}</pre>;
  return <pre className="transcript-code">{JSON.stringify(input, null, 2)}</pre>;
}

export type AnswerPermission = (id: string, decision: PermissionDecision, message: string) => void;

const decision_words: Record<PermissionDecision, string> = { allowed: "Allowed", allowed_for_run: "Allowed for this run", denied: "Denied" };

function Permission({ entry, on_answer }: { entry: PermissionEntry; on_answer?: AnswerPermission }) {
  const [reason, set_reason] = useState("");
  const waiting = !entry.decision;
  return (
    <div className={cx("transcript-step transcript-permission", waiting ? "tone-edge-warn" : entry.decision === "denied" ? "tone-edge-bad" : "tone-edge-good")} role={waiting ? "group" : undefined} aria-label={waiting ? `${entry.tool} waits for approval` : undefined}>
      <div className="inline-row">
        <Badge tone={waiting ? "warn" : entry.decision === "denied" ? "bad" : "good"}>{waiting ? "Waiting for approval" : decision_words[entry.decision!]}</Badge>
        <strong>{entry.tool}</strong> <code className="transcript-line">{tool_summary(entry.input)}</code>
      </div>
      {entry.reason && <p className="small muted">{entry.reason}</p>}
      {waiting && <ToolInput name={entry.tool} input={entry.input} />}
      {entry.message && <p className="small">Reason given: {entry.message}</p>}
      {waiting && on_answer && (
        <div className="transcript-answer">
          <input type="text" aria-label={`Why ${entry.tool} is refused`} placeholder="Why not, for the agent (optional)" value={reason} onChange={(event) => set_reason(event.currentTarget.value)} />
          <span className="inline-row">
            <button type="button" className="accent solid" onClick={() => on_answer(entry.id, "allowed", "")}>
              Allow
            </button>
            <button type="button" onClick={() => on_answer(entry.id, "allowed_for_run", "")}>
              Allow {rule_words(permission_rule(entry.tool, entry.input))} for This Run
            </button>
            <button type="button" className="danger" onClick={() => on_answer(entry.id, "denied", reason)}>
              Deny
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function Tool({ entry, live }: { entry: ToolEntry; live: boolean }) {
  const running = entry.result === undefined && live;
  return (
    <details className={cx("transcript-step transcript-tool", entry.is_error && "tone-edge-bad")}>
      <summary>
        <Badge tone={entry.is_error ? "bad" : "none"}>{entry.name}</Badge> <code className="transcript-line">{tool_summary(entry.input) || (entry.input_text ? "…" : "")}</code>
        {running && <span className="status-dot tone-info busy" role="status" aria-label="Running" />}
        {entry.is_error && <span className="tone-bad small">failed</span>}
      </summary>
      <ToolInput name={entry.name} input={entry.input} input_text={entry.input_text} />
      {entry.result !== undefined && <pre className={cx("transcript-code", entry.is_error && "tone-bad")}>{entry.result || "No output."}</pre>}
    </details>
  );
}

function UserMessage({ entry, labels }: { entry: UserEntry; labels: Record<UserRole, string> }) {
  if (entry.role === "input") {
    return (
      <details className="transcript-step">
        <summary className="muted">{labels.input}</summary>
        <Markdown text={entry.text} />
      </details>
    );
  }
  return (
    <div className="transcript-step transcript-user tone-fill-none">
      <div className="small muted">
        {labels[entry.role]} {entry.pending && <Badge tone="warn">Not read yet</Badge>}
      </div>
      <p className="transcript-text">{entry.text}</p>
    </div>
  );
}

function Step({ entry, live, labels, on_permission }: { entry: TranscriptEntry; live: boolean; labels: Record<UserRole, string>; on_permission?: AnswerPermission }) {
  if (entry.kind === "thinking") return <Thinking entry={entry} />;
  if (entry.kind === "text") return <Markdown text={entry.text} class_name="transcript-step" />;
  if (entry.kind === "tool") return <Tool entry={entry} live={live} />;
  if (entry.kind === "user") return <UserMessage entry={entry} labels={labels} />;
  if (entry.kind === "permission") return <Permission entry={entry} on_answer={live ? on_permission : undefined} />;
  return <p className={cx("transcript-step small", `tone-${entry.tone}`)}>{entry.text}</p>;
}

// ── View ─────────────────────────────────────────────────────────────────────

interface TranscriptViewProps {
  entries: TranscriptEntry[];
  // Whether steps are still arriving, which keeps the newest in view and marks tool calls without a result as running.
  live: boolean;
  // How many of the earliest steps were left out.
  dropped?: number;
  empty_text?: string;
  // The words above each kind of message from the user.
  user_labels?: Partial<Record<UserRole, string>>;
  // Answers a tool call waiting for approval; left out, waiting calls show without buttons.
  on_permission?: AnswerPermission;
}

export function TranscriptView({ entries, live, dropped = 0, empty_text = "Nothing yet.", user_labels, on_permission }: TranscriptViewProps) {
  const last = entries.at(-1);
  const size = `${entries.length} ${last && "text" in last ? last.text.length : 0} ${last?.kind === "tool" ? `${last.input_text?.length ?? 0} ${last.result?.length ?? 0}` : ""}`;
  const follow = use_follow_tail<HTMLDivElement>(size, live);
  const labels = { ...default_user_labels, ...user_labels };
  return (
    <div className="transcript-frame">
      <div ref={follow.ref} className="transcript" role="log" aria-label="Transcript" aria-live={live ? "polite" : "off"} onScroll={follow.on_scroll}>
        {dropped > 0 && <p className="muted small">{dropped} earlier steps were left out to keep the transcript within its size.</p>}
        {entries.length === 0 ? <p className="muted">{empty_text}</p> : entries.map((entry, index) => <Step key={index} entry={entry} live={live} labels={labels} on_permission={on_permission} />)}
      </div>
      {live && !follow.following && (
        <button type="button" className="transcript-jump" onClick={() => follow.set_following(true)}>
          Jump to Latest
        </button>
      )}
    </div>
  );
}
