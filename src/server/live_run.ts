// One turn of a run's Claude Code session kept open while it works: the stage input or the answers written as its first
// message, the user's messages written in as it runs, an interrupt that halts the current step and leaves the session
// waiting, and its stream folded into the run's transcript and plain output, saved as it goes. The input is closed once
// a turn ends with nothing more to say, so the session ends and the runner reads its result.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";

import { append_output, read_stream_line, tokens_of_usage, type Run, type StreamResult } from "../shared/runs/model.ts";
import { add_user_message, close_open_blocks, fold_stream_message, read_transcript, stored_transcript, type UserRole } from "../shared/runs/transcript.ts";
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

  const stream = start_claude_stream(options.argv, { cwd: options.cwd, env: options.env, signal: options.signal, on_line });

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
    is_open: stream.is_open,
    finished,
  };
}
