// GitHub's webhooks on whichever host GitHub can reach, the server or a desktop daemon that lets other devices connect: a
// delivery signed with the host's secret is kept as its repository's latest, and where the GitHub sync runs it looks at
// the items the delivery names at once, a burst of deliveries making one sync per item. The secret is made here, kept in
// a file only its user may read, and given out only by the admin's explicit show_github_webhook_setup.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { dirname } from "node:path";

import { and, eq, isNotNull, isNull, ne, sql } from "@x-tech-laboratories/x-libs/drizzle";
import { AddressLockout, Debouncer, is_signed, parse_payload, type WebhookAnswer } from "@x-tech-laboratories/x-libs/server/forge_webhook";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of } from "../shared/feature.ts";
import { read_pull_request } from "../shared/items/github.ts";
import { proposed } from "../shared/items/model.ts";
import { items } from "../shared/items/schema.ts";
import {
  delivery_id_of,
  heard_minutes,
  is_repository_name,
  payload_url_of,
  read_public_url,
  targets_of,
  webhook_content_type,
  webhook_events,
  type WebhookMethods,
  type WebhookStatus,
  type WebhookTargets,
} from "../shared/webhooks/model.ts";
import { list_deliveries, record_delivery } from "../shared/webhooks/store.ts";
import type { SyncOptions } from "./github_sync.ts";
import { register_hook } from "./github.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface GitHubWebhooksOptions {
  database: () => SqlDatabase;
  // The file holding the secret, written with mode 600.
  secret_file: string;
  // The public address and when the secret was made, beside the secret.
  settings_file: string;
  // Runs after a delivery is kept, so history and the pages hear of it and sync passes it on.
  after_write: () => void;
  // The gh program, where this host can add the hook to a repository itself.
  program?: () => string;
  // Hears what a delivery named, where the GitHub sync runs.
  on_targets?: (targets: WebhookTargets) => void;
  now?: () => Date;
}

export interface GitHubWebhooks {
  methods: WebhookMethods;
  // Answers one delivery from its sender's address, headers and raw body.
  receive: (address: string, headers: IncomingHttpHeaders, body: Buffer) => WebhookAnswer;
  // Whether the repository delivered something lately, so polling it can slow down.
  heard_recently: (repository: string) => boolean;
  // Passes on deliveries another host kept that arrived here by sync, once each.
  catch_up: () => void;
}

interface WebhookSettings {
  public_url: string;
  secret_created_at: string;
}

const secret_bytes = 32;
const deliveries_remembered = 1000;

// ── Webhooks ─────────────────────────────────────────────────────────────────

export function create_github_webhooks({ database, secret_file, settings_file, after_write, program, on_targets, now = () => new Date() }: GitHubWebhooksOptions): GitHubWebhooks {
  const lockout = new AddressLockout();
  // Delivery ids already taken, oldest first, so a replayed delivery is answered without a second sync.
  const seen = new Set<string>();
  // The delivery each repository was last passed on for, by id or time, and whether the stored ones were read yet.
  const handled = new Map<string, string>();
  let has_read_stored = false;

  function read_settings(): WebhookSettings {
    try {
      const saved = JSON.parse(readFileSync(settings_file, "utf8")) as Partial<WebhookSettings>;
      return { public_url: typeof saved.public_url === "string" ? saved.public_url : "", secret_created_at: typeof saved.secret_created_at === "string" ? saved.secret_created_at : "" };
    } catch {
      return { public_url: "", secret_created_at: "" };
    }
  }

  function write_settings(settings: WebhookSettings): void {
    mkdirSync(dirname(settings_file), { recursive: true });
    writeFileSync(settings_file, JSON.stringify(settings, null, 2));
  }

  function read_secret(): string {
    return existsSync(secret_file) ? readFileSync(secret_file, "utf8").trim() : "";
  }

  function status(): WebhookStatus {
    const settings = read_settings();
    return {
      public_url: settings.public_url,
      payload_url: payload_url_of(settings.public_url),
      content_type: webhook_content_type,
      events: [...webhook_events],
      has_secret: read_secret() !== "",
      secret_created_at: settings.secret_created_at,
      can_register: program !== undefined,
      deliveries: list_deliveries(database()),
    };
  }

  function remember(delivery_id: string): void {
    seen.add(delivery_id);
    if (seen.size > deliveries_remembered) seen.delete(seen.values().next().value!);
  }

  function is_recent(received_at: string): boolean {
    return now().getTime() - Date.parse(received_at) < heard_minutes * 60_000;
  }

  // The deliveries kept before this host started are only noted, since the poller looks at every item on start.
  function read_stored(): void {
    if (has_read_stored) return;
    has_read_stored = true;
    for (const delivery of list_deliveries(database())) if (!handled.has(delivery.repository)) handled.set(delivery.repository, delivery.delivery_id || delivery.received_at);
  }

  function receive(address: string, headers: IncomingHttpHeaders, body: Buffer): WebhookAnswer {
    if (lockout.is_locked(address)) return { status: 429, body: { message: "Too many deliveries were not signed; try again later." } };
    const secret = read_secret();
    const signature = headers["x-hub-signature-256"];
    // Only GitHub's own signature counts, never a bearer token or another forge's header.
    if (secret === "" || typeof signature !== "string" || !is_signed({ "x-hub-signature-256": signature }, body, secret)) {
      lockout.fail(address);
      return { status: 401, body: { message: "The delivery is not signed with this X-Dev's webhook secret." } };
    }
    lockout.succeed(address);

    const header = headers["x-github-event"];
    const event = typeof header === "string" ? header.toLowerCase() : "";
    const targets = event === "ping" || (webhook_events as readonly string[]).includes(event) ? targets_of(event, parse_payload(body, headers["content-type"])) : null;
    if (targets === null) return { status: 204, body: { message: "" } };

    read_stored();
    const delivery_id = delivery_id_of(headers["x-github-delivery"]);
    if (delivery_id && (seen.has(delivery_id) || handled.get(targets.repository) === delivery_id)) return { status: 200, body: { message: "Already received." } };
    if (delivery_id) remember(delivery_id);
    const received_at = now().toISOString();
    record_delivery(database(), { repository: targets.repository, delivery_id, event, received_at, targets });
    handled.set(targets.repository, delivery_id || received_at);
    after_write();
    if (event !== "ping") on_targets?.(targets);
    return { status: 202, body: { message: event === "ping" ? "Pong." : "Received." } };
  }

  function catch_up(): void {
    read_stored();
    for (const delivery of list_deliveries(database())) {
      const key = delivery.delivery_id || delivery.received_at;
      if (handled.get(delivery.repository) === key) continue;
      handled.set(delivery.repository, key);
      if (delivery.delivery_id) remember(delivery.delivery_id);
      if (delivery.event !== "ping" && is_recent(delivery.received_at)) on_targets?.(delivery.targets);
    }
  }

  function heard_recently(repository: string): boolean {
    const wanted = repository.toLowerCase();
    return list_deliveries(database()).some((delivery) => delivery.repository.toLowerCase() === wanted && is_recent(delivery.received_at));
  }

  const methods: WebhookMethods = {
    get_github_webhook: status,
    set_github_webhook_url: (public_url) => {
      write_settings({ ...read_settings(), public_url: read_public_url(public_url) });
      return status();
    },
    create_github_webhook_secret: () => {
      mkdirSync(dirname(secret_file), { recursive: true });
      // Only this user may read the secret, even where the file was there before.
      writeFileSync(secret_file, `${randomBytes(secret_bytes).toString("hex")}\n`, { mode: 0o600 });
      chmodSync(secret_file, 0o600);
      write_settings({ ...read_settings(), secret_created_at: now().toISOString() });
      return status();
    },
    show_github_webhook_setup: () => {
      const secret = read_secret();
      if (secret === "") throw new Error("Create a secret first.");
      const { payload_url, content_type, events } = status();
      return { payload_url, content_type, events, secret };
    },
    register_github_webhook: async (typed) => {
      const repository = typed.trim();
      if (!program) throw new Error("Only X-Dev on the computer that runs the agents adds hooks through gh; add this one on the repository's Webhooks settings on GitHub.");
      if (!is_repository_name(repository)) throw new Error("Name the repository as owner/name.");
      const { payload_url } = status();
      if (payload_url === "") throw new Error("Give the public address GitHub reaches X-Dev at first.");
      const secret = read_secret();
      if (secret === "") throw new Error("Create a secret first.");
      const done = await register_hook(repository, { url: payload_url, secret, events: webhook_events }, program());
      return done === "added" ? `Added the webhook to ${repository}.` : `Updated the webhook on ${repository}.`;
    },
  };

  return { methods, receive, heard_recently, catch_up };
}

// ── Syncing what a delivery named ────────────────────────────────────────────

export interface WebhookSyncOptions {
  database: () => SqlDatabase;
  sync_item: (item_id: string, options?: SyncOptions) => Promise<string>;
  // How long an item waits after the last delivery naming it, so a burst of check events makes one sync.
  delay_seconds?: number;
}

export interface WebhookSync {
  // Schedules a sync of each item the targets name and gives back their ids.
  sync_targets: (targets: WebhookTargets) => string[];
  close: () => void;
}

const default_delay_seconds = 5;

// The open items with an issue in the repository that the targets name by issue, pull request or branch.
export function items_named(database: SqlDatabase, targets: WebhookTargets): string[] {
  const numbers = new Set([...targets.issues, ...targets.pull_requests]);
  const branches = new Set(targets.branches);
  const rows = drizzle_of(database)
    .select({ id: items.id, issue_number: items.issue_number, branch: items.branch, pull_request: items.pull_request })
    .from(items)
    .where(and(eq(sql`lower(${items.repository})`, targets.repository.toLowerCase()), isNotNull(items.issue_number), ne(items.stage, proposed), isNull(items.closed_at)))
    .all();
  return rows
    .filter((row) => numbers.has(row.issue_number!) || (row.branch !== "" && branches.has(row.branch)) || numbers.has(read_pull_request(row.pull_request)?.number ?? 0))
    .map((row) => row.id);
}

export function create_webhook_sync({ database, sync_item, delay_seconds = default_delay_seconds }: WebhookSyncOptions): WebhookSync {
  const debouncer = new Debouncer(delay_seconds);
  return {
    sync_targets: (targets) => {
      const named = items_named(database(), targets);
      // A new pull request is found from the item's branch, as after a run.
      for (const item_id of named) debouncer.schedule(item_id, () => void sync_item(item_id, { find_pull_request: true }));
      return named;
    },
    close: () => debouncer.close(),
  };
}
