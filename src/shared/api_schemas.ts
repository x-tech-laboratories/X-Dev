// The argument shapes many calls share, as JSON Schema, for the specs other programs read through MCP and OpenAPI.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";

// ── Shapes ───────────────────────────────────────────────────────────────────

export function text(description: string): JsonSchema {
  return { type: "string", description };
}

export function id_of(thing: string): JsonSchema {
  return { type: "string", description: `The ${thing}'s id, as a list or get call gives it.` };
}
