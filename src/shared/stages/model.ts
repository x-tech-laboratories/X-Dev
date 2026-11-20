// What a stage is and how its fields are checked, apart from the files that hold stages, so the page shares the rules.

// ── Shapes ───────────────────────────────────────────────────────────────────

export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof efforts)[number];

// Models the bundled Claude Code backend knows by name; any other model id is taken as it is.
export const model_suggestions = ["fable", "opus", "sonnet", "haiku", "inherit"];

// Tools Claude Code offers an agent, for picking a stage's allowed and refused tools.
export const tool_suggestions = ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch"];

// The checks X-Dev runs after a stage, as docs/design.md lists them.
export const gate_names = [
  "report",
  "status",
  "worktree",
  "scope",
  "tests-fail-first",
  "tests-kept",
  "tests-pass",
  "types-lint",
  "coverage",
  "commits",
  "secrets",
  "leftovers",
  "comments",
  "size",
  "x-libs",
  "dependencies",
  "ci",
];

// How many proposals a run may make when its stage file sets none; 0 means no limit.
export const default_max_proposals = 3;

// The next stage of the last one.
export const done = "done";

export interface Stage {
  // The file's name after "stage-", such as "plan" for stage-plan.md.
  id: string;
  label: string;
  description: string;
  // Its place in the pipeline, from 1.
  order: number;
  // The stage that normally follows, or "done".
  next: string;
  // Empty for the backend's own default.
  model: string;
  effort: Effort | "";
  gates: string[];
  // How many new items a run may propose; 0 for no limit.
  max_proposals: number;
  // What the stage may change, as globs; empty for anything.
  paths: string[];
  // Empty for every tool.
  tools: string[];
  disallowed_tools: string[];
  prompt: string;
}

export type StageInput = Omit<Stage, "order">;

export interface StageProblem {
  file: string;
  problem: string;
}

export interface StageList {
  folder: string;
  stages: Stage[];
  // Stage files that could not be read, each with why.
  problems: StageProblem[];
}

// What the page asks of whichever host keeps the stage files.
export interface StagesMethods {
  list_stages: () => StageList;
  get_stage: (id: string) => Stage;
  // Adds a stage, or changes the one named by original_id, renaming its file when its id changed.
  save_stage: (stage: StageInput, original_id: string | null) => void;
  delete_stage: (id: string) => void;
  move_stage: (id: string, delta: -1 | 1) => void;
  // Writes the default stages that are missing, giving back how many it wrote.
  add_default_stages: () => number;
}

export const stages_method_names = ["list_stages", "get_stage", "save_stage", "delete_stage", "move_stage", "add_default_stages"] as const satisfies readonly (keyof StagesMethods)[];

// ── Rules ────────────────────────────────────────────────────────────────────

const id_pattern = /^[a-z][a-z0-9-]*$/;

export function is_stage_id(text: string): boolean {
  return id_pattern.test(text) && text !== done;
}

export function stage_file_name(id: string): string {
  return `stage-${id}.md`;
}

// The id a stage file's name gives, or null for any other file.
export function stage_id_of_file(file: string): string | null {
  const id = /^stage-(.+)\.md$/.exec(file)?.[1];
  return id !== undefined && is_stage_id(id) ? id : null;
}

// A label from an id when the file gives none, such as "Plan" for "plan".
export function label_of_id(id: string): string {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function clean_list(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

// The stage's fields checked and trimmed against the ids of the other stages, or an error in plain words.
export function check_stage(input: StageInput, other_ids: string[]): StageInput {
  const id = input.id.trim();
  if (!is_stage_id(id)) throw new Error(`"${id}" is not a stage id: use lower-case letters, digits and hyphens, starting with a letter`);
  if (other_ids.includes(id)) throw new Error(`there is already a stage called ${id}`);
  const label = input.label.trim() || label_of_id(id);
  const next = input.next.trim() || done;
  if (next !== done && !other_ids.includes(next)) throw new Error(`the next stage, ${next}, does not exist`);
  if (next === id) throw new Error("a stage cannot come after itself");
  if (input.effort && !efforts.includes(input.effort)) throw new Error(`"${input.effort}" is not an effort: use ${efforts.join(", ")}`);
  const gates = clean_list(input.gates);
  const unknown_gate = gates.find((gate) => !gate_names.includes(gate));
  if (unknown_gate) throw new Error(`"${unknown_gate}" is not a gate`);
  if (!Number.isInteger(input.max_proposals) || input.max_proposals < 0) throw new Error("the most proposals must be a whole number, 0 for no limit");
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("a stage needs a prompt telling its agent what to do");
  return {
    id,
    label,
    description: input.description.trim(),
    next,
    model: input.model.trim(),
    effort: input.effort,
    gates,
    max_proposals: input.max_proposals,
    paths: clean_list(input.paths),
    tools: clean_list(input.tools),
    disallowed_tools: clean_list(input.disallowed_tools),
    prompt,
  };
}

// The stages in pipeline order, ties broken by id so the order never shifts.
export function sort_stages(stages: Stage[]): Stage[] {
  return [...stages].sort((first, second) => first.order - second.order || first.id.localeCompare(second.id));
}
