// The item calls described for other programs: what each does and the arguments it takes.

// ── Imports ──────────────────────────────────────────────────────────────────

import { id_of, text } from "../api_schemas.ts";
import { item_kinds, status_limit, status_sections } from "./model.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

const status_changes = {
  type: "object",
  properties: Object.fromEntries(status_sections.map((section) => [section.key, text(`The ${section.label} section, replacing what it held.`)])),
  additionalProperties: false,
  description: `The status sheet's sections to replace; the rest stay as they are. The whole sheet holds at most ${status_limit} characters.`,
};

export const items_api = {
  list_items: {
    description: "Lists the items, each a feature or bug fix in one GitHub repository, newest first, with the stage each is at; closed items only when asked.",
    params: [{ name: "include_closed", schema: { type: "boolean", description: "Whether closed items are listed too; false when left out." }, optional: true }],
  },
  get_item: { description: "One item with its status sheet.", params: [{ name: "id", schema: id_of("item") }] },
  get_item_github: {
    description:
      "What X-Dev keeps in step with an item's GitHub issue: its pull request with the state (open, closed or merged) and each check's outcome (pass, fail, pending, skipping or cancel), the stage labels and report comments it last posted, and why the last attempt to reach GitHub failed, if it did.",
    params: [{ name: "id", schema: id_of("item") }],
  },
  save_item: {
    description: "Adds an item, or changes the one with the id given. Gives back its id.",
    params: [
      {
        name: "item",
        schema: {
          type: "object",
          properties: {
            id: text("The item's id when changing it; leave out to add one."),
            title: text("What the feature or fix is, in a few words."),
            kind: { type: "string", enum: item_kinds, description: "feature or bug." },
            repository: text("The GitHub repository as owner/name, such as x-tech-laboratories/X-Dev."),
            issue_number: { type: ["integer", "null"], minimum: 1, description: "The GitHub issue it tracks, or null for none yet." },
            body: text("What the item asks for, as an issue's body would say it."),
            stage: text("The stage it is at, such as plan; triage when left out."),
          },
          required: ["title", "repository"],
        },
      },
    ],
  },
  update_item_status: {
    description: "Replaces sections of an item's status sheet, the short summary of where its work stands that every stage reads and keeps current. Edit it in place; never append a log.",
    params: [{ name: "id", schema: id_of("item") }, { name: "changes", schema: status_changes }],
  },
  close_item: { description: "Closes an item once its work is done or dropped.", params: [{ name: "id", schema: id_of("item") }] },
  reopen_item: { description: "Opens a closed item again.", params: [{ name: "id", schema: id_of("item") }] },
  delete_item: { description: "Deletes an item; it can be brought back from its history.", params: [{ name: "id", schema: id_of("item") }], destructive: true },
};
