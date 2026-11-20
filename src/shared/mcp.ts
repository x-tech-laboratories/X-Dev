// What an AI client reads first about X-Dev, and what MCP leaves out, wherever the MCP endpoint runs: the server or
// the desktop app.

export const mcp_instructions = [
  "To add an item, call add_item with a title, the repository as owner/name or the path of its checkout, a kind (feature or bug) and a body saying what is wanted; it finds or opens the GitHub issue too. For a rough note, call describe_item first and pass the draft it gives back to add_item. Where add_item is not offered, save_item adds the item without an issue.",
  "X-Dev takes features and bug fixes, each an item in one GitHub repository, through stages such as plan, implement and review, one run at a time.",
  "To see where work stands: list_items, list_stage_runs for the board, list_proposals for the inbox, get_item for an item and its status sheet, list_runs and get_run for its runs and reports, and list_run_summaries for every run's tokens and cost.",
  "start_run, answer_run and discard_run act on the computer that holds the checkouts and start or undo an AI coding agent's work there; use them only when asked.",
  "Each item has a status sheet, a short summary of where its work stands; update it in place with update_item_status rather than appending to it.",
].join(" ");

// Settings that hold another service's key, which stay in the page's own settings.
const secret_settings: string[] = [];

export function without_secrets(method: string, result: unknown): unknown {
  if (method !== "get_settings") return result;
  return Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([key]) => !secret_settings.includes(key)));
}
