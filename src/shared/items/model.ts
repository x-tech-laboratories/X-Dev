// What an item is and how its fields are checked, apart from the database, so the page can share the rules.

// ── Shapes ───────────────────────────────────────────────────────────────────

export const item_kinds = ["feature", "bug"] as const;

export type ItemKind = (typeof item_kinds)[number];

// The sections every status sheet has, in the order the page shows them.
export const status_sections = [
  { key: "goal", label: "Goal" },
  { key: "current_state", label: "Current state" },
  { key: "decisions", label: "Decisions" },
  { key: "constraints", label: "Constraints" },
  { key: "known_problems", label: "Known problems" },
  { key: "open_questions", label: "Open questions" },
  { key: "links", label: "Links" },
] as const;

export type StatusSection = (typeof status_sections)[number]["key"];

export type StatusSheet = Record<StatusSection, string>;

export interface Item {
  id: string;
  title: string;
  kind: ItemKind;
  repository: string;
  issue_number: number | null;
  stage: string;
  status: StatusSheet;
  created_at: string;
  closed_at: string | null;
}

export interface ItemInput {
  id?: string;
  title: string;
  kind?: ItemKind;
  repository: string;
  issue_number?: number | null;
  stage?: string;
}

export interface CheckedItem {
  id?: string;
  title: string;
  kind: ItemKind;
  repository: string;
  issue_number: number | null;
  stage: string;
}

// The most a status sheet may hold, so it stays a summary rather than a log.
export const status_limit = 6000;

// ── Rules ────────────────────────────────────────────────────────────────────

const repository_pattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function is_repository(text: string): boolean {
  return repository_pattern.test(text);
}

export function empty_status(): StatusSheet {
  return Object.fromEntries(status_sections.map((section) => [section.key, ""])) as StatusSheet;
}

// A sheet read back from the database, unknown sections dropped and missing ones empty.
export function read_status(json: string): StatusSheet {
  const saved = (JSON.parse(json || "{}") ?? {}) as Record<string, unknown>;
  const sheet = empty_status();
  for (const section of status_sections) if (typeof saved[section.key] === "string") sheet[section.key] = saved[section.key] as string;
  return sheet;
}

export function status_length(sheet: StatusSheet): number {
  return Object.values(sheet).reduce((total, text) => total + text.length, 0);
}

// The item's fields checked and trimmed, or an error in plain words.
export function check_item(input: ItemInput): CheckedItem {
  const title = input.title?.trim() ?? "";
  if (!title) throw new Error("an item needs a title");
  const repository = input.repository?.trim() ?? "";
  if (!is_repository(repository)) throw new Error(`"${repository}" is not a repository such as owner/name`);
  const kind = input.kind ?? "feature";
  if (!item_kinds.includes(kind)) throw new Error(`"${String(kind)}" is not feature or bug`);
  const issue_number = input.issue_number ?? null;
  if (issue_number !== null && (!Number.isInteger(issue_number) || issue_number < 1)) throw new Error("the issue number must be a whole number above 0");
  const stage = input.stage?.trim() || "triage";
  return { id: input.id, title, kind, repository, issue_number, stage };
}

// A sheet with the sections given replaced, refused when it grows past the limit.
export function merge_status(sheet: StatusSheet, changes: Partial<Record<string, string>>): StatusSheet {
  const merged = { ...sheet };
  for (const [key, text] of Object.entries(changes)) {
    if (!status_sections.some((section) => section.key === key)) throw new Error(`"${key}" is not a status section`);
    if (typeof text !== "string") throw new Error(`the ${key} section must be text`);
    merged[key as StatusSection] = text.trim();
  }
  const length = status_length(merged);
  if (length > status_limit) throw new Error(`the status sheet would hold ${length} characters, over its limit of ${status_limit}; shorten it`);
  return merged;
}
