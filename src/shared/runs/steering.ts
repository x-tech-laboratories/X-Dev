// What the user did to a run by hand, such as a message written to it while it ran, noted in the status sheet's
// Decisions so the stages after it read how the user steered the work.

// ── Imports ──────────────────────────────────────────────────────────────────

import { merge_status, type StatusSheet } from "../items/model.ts";

// ── Decisions ────────────────────────────────────────────────────────────────

// The most of one message the sheet keeps, so it stays a summary.
const note_limit = 300;

// The sheet with one line added to Decisions, or null when the sheet has no room left for it.
export function steer_decisions(sheet: StatusSheet, stage_label: string, text: string): StatusSheet | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const note = flat.length > note_limit ? `${flat.slice(0, note_limit)}…` : flat;
  const line = `- The user told ${stage_label} while it ran: ${note}`;
  try {
    return merge_status(sheet, { decisions: sheet.decisions ? `${sheet.decisions}\n${line}` : line });
  } catch {
    return null;
  }
}
