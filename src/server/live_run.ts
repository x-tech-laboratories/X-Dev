// One turn of a run's Claude Code session kept open while it works: the stage input or the answers written as its first
// message, the user's messages written in as it runs, an interrupt that halts the current step and leaves the session
// waiting, each tool call the session asks about held for the user to allow or refuse, the permission mode switched on
// the user's word, and its stream folded into the run's transcript and plain output, saved as it goes. The input is
// closed once a turn ends with nothing more to say, so the session ends and the runner reads its result.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";

import { append_output, read_stream_line, tokens_of_usage, type Run, type StreamResult } from "../shared/runs/model.ts";
import { permission_rule, type RunMode } from "../shared/runs/modes.ts";
import { add_permission, add_user_message, close_open_blocks, fold_stream_message, read_transcript, stored_transcript, waiting_permissions, type PermissionDecision, type UserRole } from "../shared/runs/transcript.ts";
import type { RunChanges } from "../shared/runs/store.ts";
import { start_claude_stream, type StreamMessage } from "./claude_stream.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface LiveRunOptions {
  run: Run;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  first_message: { role: UserRole; text: string };
  // Saves changes to the run and tells the pages.
  save: (changes: RunChanges) => void;
  // Adds one turn's tokens to the run.
  add_tokens: (tokens: StreamResult["tokens"]) => void;
  // Whether the agent asked the user questions, after which the session ends and the run waits for answers.
  asked: () => boolean;
  now: () => string;
}

export interface LiveRunEnd {
  // The session's last result, or null when it ended without one.
  result: StreamResult | null;
  exit_code: number;
  stderr: string;
}

export interface LiveRun {
  // Writes a message from the user into the session, shown as pending until the agent has read it.
  send_message: (text: string) => void;
  // Halts the current step at once; the session stays open for the user's next message.
  interrupt: () => Promise<void>;
  // Answers a tool call the session asked about, with the reason sent back when it is refused.
  answer_permission: (request_id: string, decision: PermissionDecision, message: string) => void;
  // Switches the session's permission mode from its next tool call on.
  set_mode: (mode: RunMode) => Promise<void>;
  // Whether the session still takes messages.
  is_open: () => boolean;
  finished: Promise<LiveRunEnd>;
}

// How often the transcript is saved while a run streams.
const save_every_ms = 1000;

// ── Running ──────────────────────────────────────────────────────────────────

export function start_live_run(options: LiveRunOptions): LiveRun {
  const { run, save, now } = options;
  const transcript = read_transcript(run.transcript);
  transcript.activity = "working";
  let output = run.output;
  let result: StreamResult | null = null;
  // The session's cost is counted from its start, so each result's total replaces the one before.
  const cost_before = run.cost_usd;
  // Messages written that the session has not finished with yet, and whether it reports their progress at all.
  const outstanding = new Set<string>();
  let has_lifecycle = false;
  let turn_active = true;
  let interrupt_asked = false;
  const allowed = new Set(run.allowed);
  let save_timer: NodeJS.Timeout | null = null;
  let last_save = 0;

  function save_now(): void {
    if (save_timer) clearTimeout(save_timer);
    save_timer = null;
    last_save = Date.now();
    save({ output, transcript: stored_transcript(transcript) });
  }

  // Saves at most once a second while the stream flows, and once more after it pauses.
  function save_soon(): void {
    if (save_timer) return;
    const wait = Math.max(0, save_every_ms - (Date.now() - last_save));
    save_timer = setTimeout(save_now, wait);
  }

  // The session is ended once a turn is over, nothing written waits, and the user did not halt it to say more.
  function end_if_idle(): void {
    if (turn_active || outstanding.size > 0 || !stream.is_open()) return;
    if (transcript.activity === "paused" && !options.asked()) return;
    stream.end_input();
  }

  function on_result(message: StreamMessage, read: StreamResult): void {
    result = read;
    turn_active = false;
    options.add_tokens(tokens_of_usage(message.usage));
    if (interrupt_asked) {
      interrupt_asked = false;
      transcript.activity = "paused";
    }
    save({ cost_usd: cost_before + read.cost_usd });
    save_now();
    end_if_idle();
  }

  function on_lifecycle(message: StreamMessage): void {
    has_lifecycle = true;
    const id = String(message.command_uuid ?? "");
    if (message.state === "started") turn_active = true;
    // An interrupt cancels the message its turn was answering rather than completing it.
    if (message.state === "completed" || message.state === "cancelled") {
      outstanding.delete(id);
      end_if_idle();
    }
  }

  function on_line(line: string, message: StreamMessage | null): void {
    const read = read_stream_line(line);
    output = append_output(output, read.lines);
    if (message) {
      fold_stream_message(transcript, message);
      // Without progress reports, a message counts as read once the session echoes it.
      if (!has_lifecycle && message.type === "user" && typeof message.uuid === "string") outstanding.delete(message.uuid);
      if (message.type === "command_lifecycle") on_lifecycle(message);
      if (read.result) return on_result(message, read.result);
    }
    save_soon();
  }

  // Each waiting request's whole input, which an allowed call is handed back unchanged.
  const inputs = new Map<string, Record<string, unknown>>();

  // The tool the user is asked about first, which the board shows while it waits.
  function save_awaiting(): void {
    save({ awaiting: waiting_permissions(transcript)[0]?.tool ?? "" });
    save_now();
  }

  // A tool call the session asks about waits for the user, unless the user allowed its kind for the whole run.
  function on_request(request_id: string, request: StreamMessage): boolean {
    if (request.subtype !== "can_use_tool") return false;
    const tool = String(request.tool_name ?? "");
    const input = (request.input ?? {}) as Record<string, unknown>;
    if (allowed.has(permission_rule(tool, input))) {
      stream.respond(request_id, { behavior: "allow", updatedInput: input });
      return true;
    }
    add_permission(transcript, { id: request_id, tool, input, reason: String(request.decision_reason ?? request.description ?? "") });
    inputs.set(request_id, input);
    save_awaiting();
    return true;
  }

  const stream = start_claude_stream(options.argv, { cwd: options.cwd, env: options.env, signal: options.signal, on_line, on_request });

  function write(role: UserRole, text: string): void {
    const id = randomUUID();
    add_user_message(transcript, role, id, text, now());
    outstanding.add(id);
    turn_active = true;
    transcript.activity = "working";
    stream.send_user(text, id);
    save_now();
  }

  write(options.first_message.role, options.first_message.text);

  const finished = stream.finished.then((exit) => {
    close_open_blocks(transcript);
    transcript.activity = "ended";
    save({ awaiting: "" });
    save_now();
    return { result, exit_code: exit.exit_code, stderr: exit.stderr };
  });

  return {
    send_message: (text) => {
      if (!stream.is_open()) throw new Error("the run's session has ended");
      write("interjection", text);
    },
    interrupt: async () => {
      if (!stream.is_open()) throw new Error("the run's session has ended");
      if (!turn_active) {
        transcript.activity = "paused";
        return save_now();
      }
      interrupt_asked = true;
      await stream.control({ subtype: "interrupt" });
    },
    answer_permission: (request_id, decision, message) => {
      const entry = waiting_permissions(transcript).find((each) => each.id === request_id);
      if (!entry || !stream.is_open()) throw new Error("that request is no longer waiting");
      const input = inputs.get(request_id) ?? entry.input;
      inputs.delete(request_id);
      entry.decision = decision;
      if (decision === "denied") {
        entry.message = message.trim();
        stream.respond(request_id, { behavior: "deny", message: message.trim() || "The user refused this; do not try it again another way." });
      } else {
        stream.respond(request_id, { behavior: "allow", updatedInput: input });
      }
      if (decision === "allowed_for_run") {
        allowed.add(permission_rule(entry.tool, input));
        save({ allowed: [...allowed] });
      }
      save_awaiting();
    },
    set_mode: async (mode) => {
      if (!stream.is_open()) throw new Error("the run's session has ended");
      await stream.control({ subtype: "set_permission_mode", mode });
      transcript.mode = mode;
      save({ permission_mode: mode });
      save_now();
    },
    is_open: stream.is_open,
    finished,
  };
}
