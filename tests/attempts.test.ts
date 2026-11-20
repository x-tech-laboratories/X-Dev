import { describe, expect, it } from "vitest";

import { empty_status } from "../src/shared/items/model.ts";
import { can_retry, previous_attempt_section, waits_on_checks } from "../src/shared/runs/attempts.ts";
import { steer_decisions } from "../src/shared/runs/steering.ts";

const ci_running = { gate: "ci", outcome: "failed" as const, findings: ["still running: test; X-Dev checks again when they finish"] };
const status_failed = { gate: "status", outcome: "failed" as const, findings: ["the run did not update the status sheet"] };

describe("retrying a run", () => {
  it("is offered for a failed or stopped run, but not one held only by checks still running", () => {
    expect(can_retry({ state: "failed", gates: [], overrides: [] })).toBe(true);
    expect(can_retry({ state: "stopped", gates: [], overrides: [] })).toBe(true);
    expect(can_retry({ state: "done", gates: [], overrides: [] })).toBe(false);
    expect(can_retry({ state: "failed", gates: [ci_running], overrides: [] })).toBe(false);
    expect(waits_on_checks({ state: "failed", gates: [ci_running], overrides: [] })).toBe(true);
    expect(can_retry({ state: "failed", gates: [ci_running, status_failed], overrides: [] })).toBe(true);
    expect(can_retry({ state: "failed", gates: [ci_running, status_failed], overrides: [{ gate: "status", reason: "fine" }] })).toBe(false);
  });

  it("tells the next attempt each failed gate with its findings and the report", () => {
    const section = previous_attempt_section({ state: "failed", error: "A gate failed: status.", gates: [status_failed, { gate: "report", outcome: "passed", findings: [] }], overrides: [], report: "## Plan handoff" });
    expect(section).toBe(
      [
        "## Previous attempt",
        "",
        "This stage ran before on this item and did not finish. It failed. The worktree is as that attempt left it; carry on from there and fix what went wrong.",
        "",
        "Gates that failed:",
        "- status: the run did not update the status sheet",
        "",
        "Its report:",
        "",
        "## Plan handoff",
      ].join("\n"),
    );
  });

  it("tells the next attempt the first line of the error when no gate failed", () => {
    const section = previous_attempt_section({ state: "stopped", error: "Stopped.\nMore detail.", gates: [], overrides: [], report: "" });
    expect(section).toContain("The user stopped it before it finished.");
    expect(section).toContain("What went wrong: Stopped.");
    expect(section).not.toContain("More detail.");
    expect(section).not.toContain("Its report");
  });
});

describe("steering noted in the status sheet", () => {
  it("adds a line to Decisions, cut to a length, or gives up when the sheet is full", () => {
    const sheet = { ...empty_status(), decisions: "- Lanes per repository." };
    expect(steer_decisions(sheet, "Plan", "Keep it\nsmall.")?.decisions).toBe("- Lanes per repository.\n- The user told Plan while it ran: Keep it small.");
    expect(steer_decisions(empty_status(), "Plan", "y".repeat(400))?.decisions).toHaveLength(300 + "- The user told Plan while it ran: …".length);
    expect(steer_decisions({ ...empty_status(), goal: "z".repeat(5990) }, "Plan", "Too much.")).toBeNull();
  });
});
