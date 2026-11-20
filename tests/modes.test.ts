import { describe, expect, it } from "vitest";

import { mode_of_session, permission_rule, rule_words, starting_mode } from "../src/shared/runs/modes.ts";
import { add_permission, close_open_blocks, empty_transcript, waiting_permissions } from "../src/shared/runs/transcript.ts";

describe("a run's permission mode", () => {
  it("is the one picked for the run, else the stage's, else the runner's setting", () => {
    expect(starting_mode("default", "acceptEdits", "auto")).toBe("default");
    expect(starting_mode(undefined, "acceptEdits", "auto")).toBe("acceptEdits");
    expect(starting_mode("plan", "", "auto")).toBe("auto");
  });

  it("reads the session's own name for Manual", () => {
    expect(mode_of_session("manual")).toBe("default");
    expect(mode_of_session("acceptEdits")).toBe("acceptEdits");
    expect(mode_of_session("bypassPermissions")).toBe("");
  });
});

describe("allowing a tool for the whole run", () => {
  it("covers the tool, and for a command the program it starts", () => {
    expect(permission_rule("Bash", { command: "  npm test -- a" })).toBe("Bash(npm)");
    expect(permission_rule("Bash", { command: "" })).toBe("Bash");
    expect(permission_rule("WebFetch", { url: "https://example.org" })).toBe("WebFetch");
    expect(rule_words("Bash(npm)")).toBe("npm commands");
    expect(rule_words("WebFetch")).toBe("WebFetch");
  });
});

describe("a permission request in the transcript", () => {
  it("waits until answered, and is refused when the run ends first", () => {
    const transcript = empty_transcript();
    add_permission(transcript, { id: "p1", tool: "Write", input: { file_path: "a", content: "x".repeat(9000) }, reason: "" });
    expect(waiting_permissions(transcript).map((entry) => entry.id)).toEqual(["p1"]);
    expect(String(waiting_permissions(transcript)[0]!.input.content)).toContain("more characters left out");

    close_open_blocks(transcript);
    expect(waiting_permissions(transcript)).toEqual([]);
    expect(transcript.entries[0]).toMatchObject({ decision: "denied", message: "The run ended first." });
  });
});
