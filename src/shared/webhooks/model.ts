// GitHub's webhooks: the address GitHub posts to, the events X-Dev listens for, what a delivery may say changed, and the
// calls an admin sets them up with. A delivery only says which repository and which pull requests, branches or issues
// changed; the sync then reads everything else from GitHub itself.

// ── Setup ────────────────────────────────────────────────────────────────────

// Where GitHub posts, after the address the host is reached at.
export const webhook_path = "/api/github/webhook";

export const webhook_content_type = "application/json";

// The events to tick on GitHub; each only makes X-Dev look at the items it names.
export const webhook_events = ["pull_request", "check_suite", "check_run", "status", "workflow_run", "issues", "issue_comment"] as const;

// How long after a delivery a repository is taken as heard by webhook, so polling it slows down.
export const heard_minutes = 30;

// The payload URL for a public address such as https://dev.example.org, or "" when none is given.
export function payload_url_of(public_url: string): string {
  const trimmed = public_url.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}${webhook_path}` : "";
}

// A public address as saved: http or https with a host, no query, no fragment; anything else throws.
export function read_public_url(typed: string): string {
  const trimmed = typed.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Give the address GitHub reaches X-Dev at, such as https://dev.example.org.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash || url.username || url.password) throw new Error("The address is http or https with a host and a path, and nothing more.");
  return trimmed;
}

// ── Deliveries ───────────────────────────────────────────────────────────────

export interface WebhookTargets {
  // As owner/name.
  repository: string;
  pull_requests: number[];
  branches: string[];
  issues: number[];
}

export interface WebhookDelivery {
  repository: string;
  // GitHub's id for the delivery, from X-GitHub-Delivery, or "" when it gave none.
  delivery_id: string;
  event: string;
  received_at: string;
  targets: WebhookTargets;
}

const repository_pattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const branch_pattern = /^[A-Za-z0-9._/-]{1,255}$/;
const delivery_pattern = /^[A-Za-z0-9-]{1,100}$/;
const most_targets = 50;

type Fields = Record<string, unknown>;

function fields_of(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

function number_of(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 2 ** 31 ? value : null;
}

function branch_of(value: unknown): string | null {
  return typeof value === "string" && branch_pattern.test(value) && !value.includes("..") && !value.startsWith("-") ? value : null;
}

// The pull request numbers in a list such as check_suite.pull_requests, left out where they are not plain numbers.
function numbers_in(list: unknown): number[] {
  return (Array.isArray(list) ? list : []).map((entry) => number_of(fields_of(entry).number)).filter((number): number is number => number !== null);
}

// The repository a payload names as owner/name, or null when it names none that looks like one.
export function repository_of(payload: unknown): string | null {
  const name = fields_of(fields_of(payload).repository).full_name;
  return typeof name === "string" && repository_pattern.test(name) ? name : null;
}

// The delivery id as GitHub sends it, or "" when it is missing or not an id.
export function delivery_id_of(header: unknown): string {
  return typeof header === "string" && delivery_pattern.test(header) ? header : "";
}

// The repository and the pull requests, branches and issues a delivery names, or null; nothing else in it is kept.
export function targets_of(event: string, payload: unknown): WebhookTargets | null {
  const repository = repository_of(payload);
  if (repository === null) return null;
  const values = fields_of(payload);
  const pull_requests: (number | null)[] = [];
  const branches: (string | null)[] = [];
  const issues: (number | null)[] = [];
  if (event === "ping") {
    // Only says the hook works.
  } else if (event === "pull_request") {
    const pull = fields_of(values.pull_request);
    const head = fields_of(pull.head);
    pull_requests.push(number_of(pull.number) ?? number_of(values.number));
    // A fork's branch is not one of the repository's own, so only a branch of the same repository counts.
    if (fields_of(head.repo).full_name === repository) branches.push(branch_of(head.ref));
  } else if (event === "check_suite" || event === "workflow_run") {
    const suite = fields_of(values[event]);
    branches.push(branch_of(suite.head_branch));
    pull_requests.push(...numbers_in(suite.pull_requests));
  } else if (event === "check_run") {
    const run = fields_of(values.check_run);
    branches.push(branch_of(fields_of(run.check_suite).head_branch));
    pull_requests.push(...numbers_in(run.pull_requests));
  } else if (event === "status") {
    branches.push(...(Array.isArray(values.branches) ? values.branches : []).map((branch) => branch_of(fields_of(branch).name)));
  } else if (event === "issues" || event === "issue_comment") {
    issues.push(number_of(fields_of(values.issue).number));
  } else return null;
  const kept = <Value>(list: (Value | null)[]): Value[] => [...new Set(list.filter((value): value is Value => value !== null))].slice(0, most_targets);
  return { repository, pull_requests: kept(pull_requests), branches: kept(branches), issues: kept(issues) };
}

// A delivery's targets as stored, each list left empty where the stored text is damaged.
export function read_targets(repository: string, stored: string): WebhookTargets {
  let fields: Fields = {};
  try {
    fields = fields_of(JSON.parse(stored));
  } catch {
    fields = {};
  }
  const numbers = (value: unknown) => (Array.isArray(value) ? value.map(number_of).filter((number): number is number => number !== null) : []);
  const names = Array.isArray(fields.branches) ? fields.branches.map(branch_of).filter((branch): branch is string => branch !== null) : [];
  return { repository, pull_requests: numbers(fields.pull_requests), branches: names, issues: numbers(fields.issues) };
}

// ── Calls ────────────────────────────────────────────────────────────────────

export interface WebhookStatus {
  // The address GitHub reaches this host at, such as https://dev.example.org, or "" while not given.
  public_url: string;
  // What to enter as GitHub's Payload URL, or "" while the public address is not given.
  payload_url: string;
  content_type: string;
  events: string[];
  has_secret: boolean;
  // When the secret was made, or "" while there is none.
  secret_created_at: string;
  // Whether this host can add the hook to a repository itself, through gh.
  can_register: boolean;
  // The latest delivery from each repository, newest first.
  deliveries: WebhookDelivery[];
}

// Everything GitHub's form asks for, the secret included; given only by show_github_webhook_setup.
export interface WebhookSetup {
  payload_url: string;
  content_type: string;
  events: string[];
  secret: string;
}

export interface WebhookMethods {
  get_github_webhook: () => WebhookStatus;
  set_github_webhook_url: (public_url: string) => WebhookStatus;
  // Makes a new secret, replacing any before it; the secret itself is not given back.
  create_github_webhook_secret: () => WebhookStatus;
  show_github_webhook_setup: () => WebhookSetup;
  // Adds the hook to the repository through gh, or updates the one already pointing here, and says which.
  register_github_webhook: (repository: string) => Promise<string>;
}

export const webhook_method_names = ["get_github_webhook", "set_github_webhook_url", "create_github_webhook_secret", "show_github_webhook_setup", "register_github_webhook"] as const satisfies readonly (keyof WebhookMethods)[];

export function is_repository_name(name: string): boolean {
  return repository_pattern.test(name);
}
