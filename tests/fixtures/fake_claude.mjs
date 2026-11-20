#!/usr/bin/env node
// Stands in for claude -p in the runner's tests: reads the run's messages from stream-json input, does what words in
// them ask, and answers in stream-json as Claude Code does, with partial blocks, echoes of each message it reads,
// progress reports on them, interrupts, permission requests answered over the stream and switches of mode.

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
const session_id = option("--session-id") ?? option("--resume");

function say(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Calls one of the run's X-Dev tools as the agent would, with the address and token in its environment.
async function tool(name, args) {
  const response = await fetch(`${process.env.X_DEV_RUN_URL}/tool/${name}`, {
    method: "POST",
    headers: { "x-dev-run": process.env.X_DEV_RUN_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const answer = await response.json();
  return answer.error ? `error: ${answer.error}` : String(answer.result);
}

const report = (next) => `Done.\n\n## Plan handoff\n**Next:** ${next}\n**Done:** - planned\n**Decisions:** none\n**Work:** none\n**Open questions:** None\n**Brief for next stage:** build it`;

// ── Streaming ────────────────────────────────────────────────────────────────

let message_count = 0;
let tool_count = 0;
let turns = 0;
const queued = [];
let wake = null;
let interrupted = false;
let input_closed = false;
let mode = option("--permission-mode");
let request_count = 0;
const answers = new Map();

// Asks whether a tool may run, as Claude Code does with --permission-prompt-tool stdio, and waits for the answer.
function ask_permission(tool_name, input) {
  const request_id = `perm_${++request_count}`;
  say({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name, input, decision_reason: "It changes files outside the worktree." } });
  return new Promise((resolve) => answers.set(request_id, resolve));
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// One block streamed as the API does: its start, its pieces and its whole message, then its end.
function stream_block(block) {
  const id = `msg_${++message_count}`;
  const event = (body) => say({ type: "stream_event", event: body, session_id, api_message_id: id });
  if (block.type === "thinking") {
    event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    for (const piece of block.thinking.split(/(?<= )/)) event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: piece } });
  } else if (block.type === "text") {
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const piece of block.text.split(/(?<= )/)) event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
  } else {
    event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    const json = JSON.stringify(block.input);
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } });
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(5) } });
  }
  say({ type: "assistant", message: { id, content: [block] }, session_id });
  event({ type: "content_block_stop", index: 0 });
}

function tool_call(name, input) {
  const id = `toolu_${++tool_count}`;
  stream_block({ type: "tool_use", id, name, input });
  return id;
}

function tool_result(id, content) {
  say({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] }, session_id });
}

// Reads a message the user wrote: its progress and its echo, as Claude Code reports them.
function take(message) {
  say({ type: "command_lifecycle", command_uuid: message.uuid, state: "started", session_id });
  say({ ...message, session_id, isReplay: true });
}

function finish(text, is_error = false, reason = "completed") {
  turns += 1;
  if (!is_error) stream_block({ type: "text", text });
  say({ type: "result", subtype: is_error ? "error_during_execution" : "success", result: text, is_error, terminal_reason: reason, total_cost_usd: 0.25 * turns, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 }, session_id });
}

// Waits until a message arrives, the user interrupts, or the time runs out.
async function wait_for(milliseconds) {
  if (queued.length || interrupted) return;
  await Promise.race([new Promise((resolve) => (wake = resolve)), pause(milliseconds)]);
  wake = null;
}

async function turn(message, first) {
  const text = message.message.content.map((part) => part.text ?? "").join("\n");
  take(message);
  if (first) {
    stream_block({ type: "thinking", thinking: "I should look at the item first." });
    stream_block({ type: "text", text: "Reading the item." });
    tool_result(tool_call("Bash", { command: "git status" }), "nothing to commit");
  }
  if (text.includes("WRITE-FILE")) writeFileSync("made-by-run.txt", "made\n");
  if (text.includes("STATUS")) await tool("update_item_status", { changes: { current_state: "Planned by the fake agent." } });
  if (text.includes("PROPOSE")) {
    for (const title of ["Faster board drawing", "Another idea entirely", "A third proposal here", "A fourth proposal now"]) {
      stream_block({ type: "text", text: await tool("propose_item", { title, why: "It came up." }) });
    }
  }
  if (text.includes("The user answered")) return finish(report("implement"));
  if (text.includes("ASK")) {
    await tool("ask_user", { questions: [{ question: "Which board layout?", why: "It changes the plan.", choices: ["Lanes", "Columns"] }] });
    return finish("Waiting for the user.");
  }
  if (text.includes("NO-REPORT")) return finish("I forgot the report.");
  if (text.includes("PERMIT")) {
    for (let count = 0; count < (text.includes("TWICE") ? 2 : 1); count += 1) {
      const input = { command: "rm -rf build" };
      const id = tool_call("Bash", input);
      const answer = await ask_permission("Bash", input);
      if (answer.behavior === "allow") tool_result(id, "removed");
      else say({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: answer.message, is_error: true }] }, session_id });
    }
  }
  if (text.includes("MODE")) stream_block({ type: "text", text: `Mode is ${mode}.` });
  if (text.includes("SLOW") || text.includes("LISTEN")) {
    const id = tool_call("Bash", { command: "sleep 30" });
    await wait_for(text.includes("SLOW") ? 30_000 : 10_000);
    if (interrupted) {
      interrupted = false;
      tool_result(id, "Interrupted");
      say({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] }, session_id });
      finish("", true, "aborted_tools");
      return "cancelled";
    }
    tool_result(id, "slept");
    const heard = queued.shift();
    if (heard) {
      take(heard);
      stream_block({ type: "text", text: `Heard: ${heard.message.content[0].text}` });
      say({ type: "command_lifecycle", command_uuid: heard.uuid, state: "completed", session_id });
    }
  }
  if (!first) stream_block({ type: "text", text: `Going on after: ${text}` });
  finish(report("specify"));
}

async function serve() {
  say({ type: "system", subtype: "init", session_id, model: "claude-fake-1", permissionMode: option("--permission-prompt-tool") === "stdio" ? mode : "no-prompt-tool" });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === "control_response") {
      answers.get(message.response.request_id)?.(message.response.response);
      return;
    }
    if (message.type === "control_request") {
      if (message.request.subtype === "interrupt") interrupted = true;
      if (message.request.subtype === "set_permission_mode") mode = message.request.mode;
      say({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: message.request.subtype === "set_permission_mode" ? { mode } : {} } });
      wake?.();
      return;
    }
    say({ type: "command_lifecycle", command_uuid: message.uuid, state: "queued", session_id });
    queued.push(message);
    wake?.();
  });
  lines.on("close", () => {
    input_closed = true;
    wake?.();
  });
  let first = true;
  for (;;) {
    while (!queued.length && !input_closed) await new Promise((resolve) => (wake = resolve));
    const message = queued.shift();
    if (!message) break;
    const ended = await turn(message, first);
    first = false;
    say({ type: "command_lifecycle", command_uuid: message.uuid, state: ended === "cancelled" ? "cancelled" : "completed", session_id });
  }
}

await serve();
// A wait cut short by an interrupt leaves its timer behind, which would keep the process alive.
process.exit(0);
