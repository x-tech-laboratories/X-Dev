import { describe, expect, it } from "vitest";

import { check_ci } from "../src/shared/gates/model.ts";
import { checks_pending, comment_of_run, digest_of, read_mirror, read_pull_request, status_block, status_marker, wanted_labels, with_status, type PullRequest } from "../src/shared/items/github.ts";
import { empty_status } from "../src/shared/items/model.ts";

function pull_request(changes: Partial<PullRequest> = {}): PullRequest {
  return { number: 12, url: "https://github.com/owner/repo/pull/12", state: "open", draft: false, checks: [], changed_at: "", ...changes };
}

describe("the status sheet in the issue's body", () => {
  const block = status_block({ ...empty_status(), goal: "Lanes on the board.", links: "Branch worktree-item-7" });

  it("names each filled section between the markers", () => {
    expect(block.startsWith(status_marker)).toBe(true);
    expect(block.endsWith(status_marker)).toBe(true);
    expect(block).toContain("**Goal**\n\nLanes on the board.");
    expect(block).not.toContain("**Decisions**");
    expect(status_block(empty_status())).toContain("Nothing yet.");
  });

  it("goes at the top, leaving the rest of the body exactly as it was", () => {
    const body = "What it asks for.\n\n  - keeps spacing  \n";
    const first = with_status(body, block);
    expect(first).toBe(`${block}\n\n${body}`);

    const later = with_status(first, status_block({ ...empty_status(), goal: "Changed." }));
    expect(later.endsWith(`\n\n${body}`)).toBe(true);
    expect(later).toContain("Changed.");
    expect(later).not.toContain("Lanes on the board.");
    expect(with_status("", block)).toBe(block);
  });

  it("is replaced where it stands when someone moved it", () => {
    const body = `Intro.\n${block}\nAfter.`;
    expect(with_status(body, "NEW")).toBe("Intro.\nNEW\nAfter.");
  });
});

describe("report comments", () => {
  const run = { id: "run-1", stage_label: "Plan", state: "done", report: "## Plan handoff\n**Next:** specify", failed_gates: [] };

  it("start with the handoff marker and name the run", () => {
    const body = comment_of_run(run)!;
    expect(body.startsWith("<!-- stage-handoff -->\n<!-- x-dev-run: run-1 -->\n## Plan handoff")).toBe(true);
  });

  it("name the gates that held the run, and none for a run with no report", () => {
    expect(comment_of_run({ ...run, state: "failed", failed_gates: ["ci", "secrets"] })).toContain("**Gates failed:** ci, secrets");
    expect(comment_of_run({ ...run, state: "running" })).toBeNull();
    expect(comment_of_run({ ...run, state: "failed", report: "" })).toBeNull();
  });

  it("say so once the run is discarded", () => {
    expect(comment_of_run({ ...run, state: "discarded" })).toContain("This Plan run was discarded in X-Dev");
  });

  it("change their fingerprint when the text changes", () => {
    expect(digest_of("a")).toBe(digest_of("a"));
    expect(digest_of("a")).not.toBe(digest_of("b"));
  });
});

describe("stage labels", () => {
  it("are the stage, and needs-input while a run waits on the user", () => {
    expect(wanted_labels("plan", false)).toEqual(["stage:plan"]);
    expect(wanted_labels("plan", true)).toEqual(["stage:plan", "stage:needs-input"]);
  });
});

describe("reading what was saved", () => {
  it("fills a damaged mirror with empty fields", () => {
    expect(read_mirror("not json")).toEqual({ labels: [], comments: {}, sheet: "", closed: false, problem: "", synced_at: null });
    expect(read_mirror(JSON.stringify({ labels: ["stage:plan", 3], comments: { a: { id: 4, digest: "x" }, b: { id: "no" } }, closed: true }))).toMatchObject({ labels: ["stage:plan"], comments: { a: { id: 4, digest: "x" } }, closed: true });
  });

  it("reads a pull request, or none", () => {
    expect(read_pull_request("")).toBeNull();
    expect(read_pull_request(JSON.stringify({ number: 3 }))).toBeNull();
    expect(read_pull_request(JSON.stringify({ number: 3, url: "u", state: "odd", checks: [{ name: "test", bucket: "odd" }] }))).toEqual({ number: 3, url: "u", state: "open", draft: false, checks: [{ name: "test", workflow: "", bucket: "pending", link: "" }], changed_at: "" });
  });

  it("knows when checks still run", () => {
    expect(checks_pending(pull_request({ checks: [{ name: "test", workflow: "CI", bucket: "pending", link: "" }] }))).toBe(true);
    expect(checks_pending(pull_request({ state: "merged", checks: [{ name: "test", workflow: "CI", bucket: "pending", link: "" }] }))).toBe(false);
    expect(checks_pending(null)).toBe(false);
  });
});

describe("the ci gate", () => {
  const check = (bucket: "pass" | "fail" | "pending" | "skipping" | "cancel", name = "test") => ({ name, workflow: "CI", bucket, link: "" });

  it("passes when every check passed or was skipped", () => {
    expect(check_ci(pull_request({ checks: [check("pass"), check("skipping", "deploy")] }))).toEqual({ gate: "ci", outcome: "passed", findings: [] });
  });

  it("fails on a failed or cancelled check, naming it", () => {
    expect(check_ci(pull_request({ checks: [check("fail"), check("cancel", "lint"), check("pass", "build")] }))).toEqual({ gate: "ci", outcome: "failed", findings: ["CI / test failed", "CI / lint was cancelled"] });
  });

  it("holds the item while checks still run", () => {
    expect(check_ci(pull_request({ checks: [check("pending")] })).findings[0]).toContain("still running: test");
  });

  it("is not checked without a pull request or checks, and fails for one closed unmerged", () => {
    expect(check_ci(null).outcome).toBe("skipped");
    expect(check_ci(pull_request()).outcome).toBe("skipped");
    expect(check_ci(pull_request({ state: "closed" })).findings).toEqual(["pull request #12 was closed without merging"]);
  });
});
