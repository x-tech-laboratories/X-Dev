// The runner calls that act on a run while it runs or after it ended, described for other programs: what each does and
// the arguments it takes.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import { id_of, text } from "../api_schemas.ts";
import { run_modes } from "./modes.ts";
import type { RunnerMethods } from "./runner.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

export const live_run_api: ApiSpec<Pick<RunnerMethods, "interject_run" | "interrupt_run" | "retry_run" | "set_run_mode" | "answer_permission">> = {
  interject_run: {
    description: "Writes a message from the user into the run under way; its agent reads it once its current step ends. The message stays in the run and is added to the item's status sheet under Decisions.",
    params: [{ name: "run_id", schema: id_of("run") }, { name: "text", schema: text("The message, in plain words.") }],
  },
  interrupt_run: {
    description: "Halts the current step of the run under way at once, without ending it: the agent's session stays open and waits for the user's next message.",
    params: [{ name: "run_id", schema: id_of("run") }],
  },
  retry_run: {
    description:
      "Runs a failed or stopped run's stage again and gives back the new run's id. The new run is told how the last attempt ended, its failed gates and its report, and works on in the worktree as that attempt left it; with clean, the failed run is discarded first and the stage starts afresh. A run held only by pull request checks still running is not retried, since it clears by itself.",
    params: [
      { name: "run_id", schema: id_of("run") },
      {
        name: "options",
        schema: { type: "object", properties: { model: text("A model for the retry alone."), mode: { type: "string", enum: [...run_modes], description: "A permission mode for the retry alone." }, clean: { type: "boolean", description: "Discard the failed run first and start afresh." } }, additionalProperties: false, description: "The model and whether to start clean; both may be left out." },
      },
    ],
    destructive: true,
  },
  set_run_mode: {
    description: "Switches the permission mode of the run under way: auto checks each tool call with no one watching, acceptEdits lets file edits through and asks the user for the rest, default asks the user for every call that is not plainly safe.",
    params: [{ name: "run_id", schema: id_of("run") }, { name: "mode", schema: { type: "string", enum: [...run_modes], description: "The new mode." } }],
  },
  answer_permission: {
    description: "Allows or refuses a tool call the run under way waits on, as its transcript lists it. allowed_for_run also lets through later calls of the same tool, or for a command the same program, for the rest of the run.",
    params: [
      { name: "run_id", schema: id_of("run") },
      { name: "request_id", schema: text("The waiting request's id, from the run's transcript.") },
      { name: "decision", schema: { type: "string", enum: ["allowed", "allowed_for_run", "denied"], description: "What to do with the call." } },
      { name: "message", schema: text("For a refusal, why, which the agent reads; empty otherwise.") },
    ],
  },
};
