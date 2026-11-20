// The latest GitHub delivery from each repository, kept in the database so it syncs: a server that hears GitHub tells
// the desktop daemons syncing with it, which then look at the items it names, and every device shows when each
// repository was last heard from.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { define_feature } from "../feature.ts";
import { read_targets, type WebhookDelivery } from "./model.ts";

// ── Store ────────────────────────────────────────────────────────────────────

export const webhooks_feature = define_feature({
  id: "webhooks",
  migrations: [`CREATE TABLE github_deliveries (repository TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, event TEXT NOT NULL, received_at TEXT NOT NULL, targets TEXT NOT NULL)`],
  tables: [{ name: "github_deliveries", key_columns: ["repository"] }],
  // Read and written by the webhook calls an admin reaches, not by the page's data calls.
  methods: {},
  api: {},
});

// Keeps a delivery as its repository's latest.
export function record_delivery(database: SqlDatabase, delivery: WebhookDelivery): void {
  const { repository, delivery_id, event, received_at, targets } = delivery;
  const stored = JSON.stringify({ pull_requests: targets.pull_requests, branches: targets.branches, issues: targets.issues });
  database
    .prepare("INSERT INTO github_deliveries (repository, delivery_id, event, received_at, targets) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repository) DO UPDATE SET delivery_id = excluded.delivery_id, event = excluded.event, received_at = excluded.received_at, targets = excluded.targets")
    .run(repository, delivery_id, event, received_at, stored);
}

// Each repository's latest delivery, newest first.
export function list_deliveries(database: SqlDatabase): WebhookDelivery[] {
  const rows = database.prepare("SELECT repository, delivery_id, event, received_at, targets FROM github_deliveries ORDER BY received_at DESC").all() as { repository: string; delivery_id: string; event: string; received_at: string; targets: string }[];
  return rows.map((row) => ({ repository: row.repository, delivery_id: row.delivery_id, event: row.event, received_at: row.received_at, targets: read_targets(row.repository, row.targets) }));
}
