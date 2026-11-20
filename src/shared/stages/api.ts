// The stage file calls described for other programs: what each does and the arguments it takes.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import { text } from "../api_schemas.ts";
import { efforts, type StagesMethods } from "./model.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

const words = (description: string) => ({ type: "array", items: { type: "string" }, description });

const stage_input = {
  type: "object",
  description: "The whole stage as its file holds it.",
  properties: {
    id: text("The stage's id, the file's name after stage-, such as plan."),
    label: text("The name the page shows, such as Plan."),
    description: text("What the stage does, in one line."),
    next: text("The stage that normally follows, or done."),
    model: text("The model, by alias or id; empty for the backend's default."),
    effort: { type: "string", enum: ["", ...efforts], description: "The reasoning effort; empty for the default." },
    gates: words("The gates run after the stage, such as report and status."),
    max_proposals: { type: "integer", minimum: 0, description: "How many new items one run may propose; 0 for no limit." },
    paths: words("What the stage may change, as globs; empty for anything."),
    tools: words("The tools the agent may use; empty for every tool."),
    disallowed_tools: words("The tools the agent may not use."),
    prompt: text("The prompt, as plain text."),
  },
  required: ["id", "label", "description", "next", "model", "effort", "gates", "max_proposals", "paths", "tools", "disallowed_tools", "prompt"],
  additionalProperties: false,
};

// Served only to an admin, since a stage file tells agents what to do on the computer that runs them.
export const stages_api: ApiSpec<StagesMethods> = {
  list_stages: { description: "Lists the stages in order, each with its model, effort, next stage, gates, tools and prompt, the folder their files are in, and the files that could not be read.", params: [] },
  get_stage: { description: "One stage with its model, effort, next stage, gates, tools, the paths it may change and its prompt.", params: [{ name: "id", schema: text("The stage's id, such as plan.") }] },
  save_stage: {
    description: "Adds a stage, or changes the one named by original_id, writing its agent file on the computer that runs the agents; every later run of that stage follows it, so it changes what agents do there. Keys X-Dev does not know are kept.",
    params: [{ name: "stage", schema: stage_input }, { name: "original_id", schema: { type: ["string", "null"], description: "The id of the stage being changed, or null for a new one." } }],
  },
  delete_stage: { description: "Deletes a stage's agent file on the computer that runs the agents.", params: [{ name: "id", schema: text("The stage's id.") }], destructive: true },
  move_stage: { description: "Moves a stage one place earlier or later in the pipeline.", params: [{ name: "id", schema: text("The stage's id.") }, { name: "delta", schema: { type: "integer", enum: [-1, 1], description: "-1 for earlier, 1 for later." } }] },
  add_default_stages: { description: "Writes the default stages that are missing as agent files on the computer that runs the agents, and gives back how many it wrote.", params: [] },
};
