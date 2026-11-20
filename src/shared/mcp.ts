// What an AI client reads first about X-Dev, and what MCP leaves out, wherever the MCP endpoint runs: the server or
// the desktop app.

export const mcp_instructions = [
  "X-Dev takes features and bug fixes, each an item in one GitHub repository, through stages such as plan, implement and review, one run at a time.",
  "Each item has a status sheet, a short summary of where its work stands; update it in place with update_item_status rather than appending to it.",
  "list_items is the place to start.",
].join(" ");

// Settings that hold another service's key, which stay in the page's own settings.
const secret_settings: string[] = [];

export function without_secrets(method: string, result: unknown): unknown {
  if (method !== "get_settings") return result;
  return Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([key]) => !secret_settings.includes(key)));
}
