// What the user did to a run by hand, such as a message written to it while it ran or a file put back as it was, noted
// in the status sheet's Decisions so the stages after it read how the user steered the work.

// ── Imports ──────────────────────────────────────────────────────────────────

import { merge_status, type StatusSheet } from "../items/model.ts";

// ── Decisions ────────────────────────────────────────────────────────────────

// The most of one message the sheet keeps, so it stays a summary.
const note_limit = 300;

// The sheet with one line added to Decisions, or null when the sheet has no room left for it.
export function steer_decisions(sheet: StatusSheet, stage_label: string, text: string): StatusSheet | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const note = flat.length > note_limit ? `${flat.slice(0, note_limit)}…` : flat;
  return add_decision(sheet, `- The user told ${stage_label} while it ran: ${note}`);
}

// The sheet noting that the user put a file back as it was, or null when it has no room left.
export function revert_decisions(sheet: StatusSheet, path: string, scope: "run" | "item", stage_label: string): StatusSheet | null {
  return add_decision(sheet, `- The user reverted ${path} to how it was before ${scope === "run" ? `the ${stage_label} run` : "the item's work"}; do not bring the change back.`);
}

function add_decision(sheet: StatusSheet, line: string): StatusSheet | null {
  try {
    return merge_status(sheet, { decisions: sheet.decisions ? `${sheet.decisions}\n${line}` : line });
  } catch {
    return null;
  }
}
