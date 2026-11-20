// A Claude Code session driven over its stream-json protocol, as `claude -p --input-format stream-json` speaks it: user
// messages written to its input at any time, control requests such as an interrupt answered by id, the session's own
// requests, such as asking whether a tool may run, answered back, and every other line it prints handed on whole and parsed.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";

import { start_line_program, type LineProgramExit } from "./line_program.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type StreamMessage = Record<string, unknown>;

export interface ClaudeStreamOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  // Each line the session prints, with its JSON when it is JSON; answers to this side's control requests are kept back.
  on_line: (line: string, message: StreamMessage | null) => void;
  // A request from the session, such as can_use_tool, answered later through respond; any it does not take is refused.
  on_request?: (request_id: string, request: StreamMessage) => boolean;
}

export interface ClaudeStream {
  // Writes a user message with the id the session echoes back once it has read it.
  send_user: (text: string, id: string) => void;
  // Sends a control request, such as {subtype: "interrupt"}, and settles with the session's answer.
  control: (request: StreamMessage) => Promise<StreamMessage>;
  // Answers one of the session's own requests.
  respond: (request_id: string, response: StreamMessage) => void;
  // Closes the input, after which the session ends once its turn is over.
  end_input: () => void;
  is_open: () => boolean;
  finished: Promise<LineProgramExit>;
}

// How long a control request waits for its answer.
const control_timeout_in_milliseconds = 30_000;

// ── Session ──────────────────────────────────────────────────────────────────

export function start_claude_stream(argv: readonly string[], options: ClaudeStreamOptions): ClaudeStream {
  const waiting = new Map<string, { resolve: (answer: StreamMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  function on_line(line: string): void {
    if (!line.trim()) return;
    let message: StreamMessage | null = null;
    try {
      message = JSON.parse(line) as StreamMessage;
    } catch {
      message = null;
    }
    if (message?.type === "control_response") {
      const response = (message.response ?? {}) as StreamMessage;
      const waiter = waiting.get(String(response.request_id ?? ""));
      if (!waiter) return;
      waiting.delete(String(response.request_id));
      clearTimeout(waiter.timer);
      if (response.subtype === "error") waiter.reject(new Error(String(response.error ?? "the session refused the request")));
      else waiter.resolve((response.response ?? {}) as StreamMessage);
      return;
    }
    if (message?.type === "control_request") {
      const request_id = String(message.request_id ?? "");
      const taken = options.on_request?.(request_id, (message.request ?? {}) as StreamMessage) ?? false;
      if (!taken) program.write_line(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id, error: "X-Dev does not answer this request" } }));
      return;
    }
    options.on_line(line, message);
  }

  const program = start_line_program(argv, { cwd: options.cwd, env: options.env, signal: options.signal, on_line });
  const finished = program.finished.then((exit) => {
    for (const [id, waiter] of waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the session ended before it answered"));
      waiting.delete(id);
    }
    return exit;
  });

  return {
    send_user: (text, id) => program.write_line(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, uuid: id })),
    control: (request) =>
      new Promise<StreamMessage>((resolve, reject) => {
        if (!program.is_open()) return reject(new Error("the session is no longer taking requests"));
        const request_id = randomUUID();
        const timer = setTimeout(() => {
          waiting.delete(request_id);
          reject(new Error("the session did not answer in time"));
        }, control_timeout_in_milliseconds);
        waiting.set(request_id, { resolve, reject, timer });
        program.write_line(JSON.stringify({ type: "control_request", request_id, request }));
      }),
    respond: (request_id, response) => program.write_line(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id, response } })),
    end_input: program.end_input,
    is_open: program.is_open,
    finished,
  };
}
