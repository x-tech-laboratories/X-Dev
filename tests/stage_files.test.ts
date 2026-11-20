import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { default_stages } from "../src/server/default_stages.ts";
import { create_stage_files, parse_stage_file, stage_of_file, write_stage_file } from "../src/server/stage_files.ts";
import { check_stage, label_of_id, stage_id_of_file, type StageInput } from "../src/shared/stages/model.ts";

function folder(): string {
  return mkdtempSync(join(tmpdir(), "x-dev-stages-"));
}

const plan: StageInput = {
  id: "plan",
  label: "Plan",
  description: "Writes the plan.",
  next: "done",
  model: "fable",
  effort: "high",
  gates: ["report", "status"],
  paths: [],
  tools: [],
  disallowed_tools: ["Edit", "Write"],
  prompt: "You are the Plan stage.",
};

// ============================================================================
// Rules
// ============================================================================

describe("a stage's fields", () => {
  it("take their id from the file's name, and a label from the id", () => {
    expect(stage_id_of_file("stage-plan.md")).toBe("plan");
    expect(stage_id_of_file("stage-x-libs.md")).toBe("x-libs");
    expect(stage_id_of_file("stage-done.md")).toBeNull();
    expect(stage_id_of_file("reviewer.md")).toBeNull();
    expect(label_of_id("x-libs")).toBe("X Libs");
  });

  it("are trimmed, the label and next filled in when left empty", () => {
    expect(check_stage({ ...plan, id: " plan ", label: "", next: "", gates: [" report ", "report", ""] }, [])).toMatchObject({ id: "plan", label: "Plan", next: "done", gates: ["report"] });
  });

  it("are refused in plain words when wrong", () => {
    expect(() => check_stage({ ...plan, id: "Plan" }, [])).toThrow('"Plan" is not a stage id');
    expect(() => check_stage(plan, ["plan"])).toThrow("there is already a stage called plan");
    expect(() => check_stage({ ...plan, next: "build" }, [])).toThrow("the next stage, build, does not exist");
    expect(() => check_stage({ ...plan, effort: "huge" as never }, [])).toThrow('"huge" is not an effort');
    expect(() => check_stage({ ...plan, gates: ["vibes"] }, [])).toThrow('"vibes" is not a gate');
    expect(() => check_stage({ ...plan, prompt: " " }, [])).toThrow("a stage needs a prompt");
  });
});

// ============================================================================
// Files
// ============================================================================

describe("a stage file", () => {
  it("reads Claude Code's keys and X-Dev's own", () => {
    const text = "---\nname: stage-plan\ndescription: Plans.\nmodel: fable\neffort: high\ntools: Read, Grep\nx-dev-order: 2\nx-dev-next: implement\nx-dev-gates: [report]\n---\n\nYou are the Plan stage.\n";
    expect(stage_of_file("plan", parse_stage_file(text))).toEqual({
      id: "plan",
      label: "Plan",
      description: "Plans.",
      order: 2,
      next: "implement",
      model: "fable",
      effort: "high",
      gates: ["report"],
      paths: [],
      tools: ["Read", "Grep"],
      disallowed_tools: [],
      prompt: "You are the Plan stage.",
    });
  });

  it("is refused without frontmatter or with broken YAML", () => {
    expect(() => parse_stage_file("You are a stage.")).toThrow("it does not start with a frontmatter block");
    expect(() => parse_stage_file("---\nname: [\n---\nPrompt")).toThrow("its frontmatter is not valid YAML");
  });

  it("keeps keys and comments X-Dev does not know when written back", () => {
    const previous = parse_stage_file("---\nname: stage-plan # the agent's name\ncolor: blue\nmodel: opus\n---\nOld prompt\n");
    const text = write_stage_file({ ...plan, order: 1 }, previous.frontmatter);

    expect(text).toContain("name: stage-plan # the agent's name");
    expect(text).toContain("color: blue");
    expect(text).toContain("model: fable");
    expect(text).toContain("disallowedTools: Edit, Write");
    expect(text).not.toContain("x-dev-paths");
    expect(text.endsWith("\n\nYou are the Plan stage.\n")).toBe(true);
    expect(stage_of_file("plan", parse_stage_file(text))).toEqual({ ...plan, order: 1 });
  });
});

// ============================================================================
// Folder
// ============================================================================

describe("the stage folder", () => {
  it("adds the default stages in order, and only the missing ones the second time", () => {
    const stages = create_stage_files({ folder: folder() }).methods;

    expect(stages.add_default_stages()).toBe(default_stages.length);
    expect(stages.list_stages().stages.map((stage) => [stage.order, stage.id])).toEqual(default_stages.map((stage, index) => [index + 1, stage.id]));
    expect(stages.add_default_stages()).toBe(0);
  });

  it("lists a file it cannot read as a problem, leaves other files be, and never overwrites it with a default", () => {
    const path = folder();
    writeFileSync(join(path, "stage-plan.md"), "no frontmatter here");
    writeFileSync(join(path, "reviewer.md"), "---\nname: reviewer\n---\nSomeone else's agent.");
    const stages = create_stage_files({ folder: path }).methods;

    expect(stages.list_stages().problems).toEqual([{ file: "stage-plan.md", problem: "it does not start with a frontmatter block between --- lines" }]);
    stages.add_default_stages();
    expect(readFileSync(join(path, "stage-plan.md"), "utf8")).toBe("no frontmatter here");
    expect(readFileSync(join(path, "reviewer.md"), "utf8")).toContain("Someone else's agent.");
  });

  it("adds a stage last, edits it, and renames its file, pointing the stages before it at the new id", () => {
    const path = folder();
    const on_change = vi.fn();
    const stages = create_stage_files({ folder: path, on_change }).methods;
    stages.save_stage(plan, null);
    stages.save_stage({ ...plan, id: "triage", label: "Triage", next: "plan" }, null);

    expect(stages.list_stages().stages.map((stage) => [stage.id, stage.order])).toEqual([["plan", 1], ["triage", 2]]);
    stages.save_stage({ ...plan, id: "design", label: "Design" }, "plan");

    expect(existsSync(join(path, "stage-plan.md"))).toBe(false);
    expect(stages.list_stages().stages.map((stage) => [stage.id, stage.order, stage.next])).toEqual([["design", 1, "done"], ["triage", 2, "design"]]);
    expect(on_change).toHaveBeenCalledTimes(3);
    expect(() => stages.save_stage(plan, "missing")).toThrow("no stage missing");
  });

  it("moves a stage and numbers them all again", () => {
    const stages = create_stage_files({ folder: folder() }).methods;
    stages.add_default_stages();

    stages.move_stage("plan", -1);
    expect(stages.list_stages().stages.slice(0, 3).map((stage) => [stage.order, stage.id])).toEqual([[1, "plan"], [2, "triage"], [3, "specify"]]);
    stages.move_stage("plan", -1);
    expect(stages.list_stages().stages[0]!.id).toBe("plan");
    expect(() => stages.move_stage("missing", 1)).toThrow("no stage missing");
  });

  it("deletes a stage, the one before it going on to where it went", () => {
    const path = folder();
    const stages = create_stage_files({ folder: path }).methods;
    stages.add_default_stages();

    stages.delete_stage("specify");

    const list = stages.list_stages().stages;
    expect(list.find((stage) => stage.id === "plan")!.next).toBe("implement");
    expect(list.map((stage) => stage.order)).toEqual(list.map((_stage, index) => index + 1));
    expect(readdirSync(path)).not.toContain("stage-specify.md");
    expect(() => stages.delete_stage("specify")).toThrow("no stage specify");
  });

  it("hears of a stage file changed by another program", async () => {
    const path = folder();
    const on_change = vi.fn();
    const files = create_stage_files({ folder: path, on_change });
    const stop = files.watch();

    writeFileSync(join(path, "stage-plan.md"), "---\nname: stage-plan\n---\nPlan.");
    await vi.waitFor(() => expect(on_change).toHaveBeenCalled(), { timeout: 3000 });
    stop();
  });
});
