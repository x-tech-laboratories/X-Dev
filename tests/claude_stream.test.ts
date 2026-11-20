import { describe, expect, it } from "vitest";

import { start_claude_stream, type StreamMessage } from "../src/server/claude_stream.ts";
import { start_line_program } from "../src/server/line_program.ts";

// A stand-in session written inline: it echoes each line it reads, refuses control requests and ends when its input does.
const echo_session = `
const lines = require("node:readline").createInterface({ input: process.stdin });
const say = (text) => process.stdout.write(text + "\\n");
say("plain words");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") say(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "not now" } }));
  else say(JSON.stringify({ ...message, isReplay: true }));
});
`;

describe("a Claude Code stream session", () => {
  it("writes user messages with their ids, hands on every line, and passes a refused control request on as an error", async () => {
    const seen: [string, StreamMessage | null][] = [];
    const stream = start_claude_stream([process.execPath, "-e", echo_session], { on_line: (line, message) => seen.push([line, message]) });

    stream.send_user("Hello.", "u1");
    await expect(stream.control({ subtype: "interrupt" })).rejects.toThrow("not now");
    stream.end_input();
    expect(stream.is_open()).toBe(false);
    expect(await stream.finished).toEqual({ exit_code: 0, stderr: "" });

    expect(seen[0]).toEqual(["plain words", null]);
    expect(seen[1]![1]).toMatchObject({ type: "user", uuid: "u1", isReplay: true, message: { content: [{ type: "text", text: "Hello." }] } });
    await expect(stream.control({ subtype: "interrupt" })).rejects.toThrow("no longer taking requests");
  });

  it("refuses a control request still waiting when the session ends", async () => {
    const stream = start_claude_stream([process.execPath, "-e", "setTimeout(() => process.exit(3), 200)"], { on_line: () => undefined });
    await expect(stream.control({ subtype: "interrupt" })).rejects.toThrow("the session ended before it answered");
    expect((await stream.finished).exit_code).toBe(3);
  });
});

describe("a program talked to in lines", () => {
  it("says a program that is not installed is missing", async () => {
    const program = start_line_program(["x-dev-no-such-program"], { on_line: () => undefined });
    expect(await program.finished).toEqual({ exit_code: 127, stderr: "x-dev-no-such-program is not installed on this host" });
    program.write_line("ignored");
  });

  it("is stopped by its signal, and not started when the signal came first", async () => {
    const controller = new AbortController();
    const program = start_line_program([process.execPath, "-e", "setInterval(() => {}, 1000)"], { on_line: () => undefined, signal: controller.signal });
    controller.abort();
    expect((await program.finished).exit_code).toBe(143);

    const never = start_line_program([process.execPath], { on_line: () => undefined, signal: controller.signal });
    expect(never.is_open()).toBe(false);
    expect(await never.finished).toEqual({ exit_code: -1, stderr: "Stopped before it started" });
  });

  it("hands on a last line that has no line break", async () => {
    const lines: string[] = [];
    const program = start_line_program([process.execPath, "-e", "process.stdout.write('one\\ntwo')"], { on_line: (line) => lines.push(line) });
    await program.finished;
    expect(lines).toEqual(["one", "two"]);
  });
});
