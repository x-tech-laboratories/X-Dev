// The one database every X-Dev device keeps: every feature's tables brought up to date, sync set to stamp every
// change, and every feature's calls in one table the page reaches through whichever host it runs on.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";
import { migrate, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";
import { create_sync_engine } from "@x-tech-laboratories/x-libs/sync_engine";

import { forget_synced_changes, history_feature, install_history, record_history } from "./history/store.ts";
import { items_feature } from "./items/store.ts";
import { runs_feature } from "./runs/store.ts";
import { is_read_only } from "./page_api.ts";
import { create_settings_feature } from "./settings.ts";
import { webhooks_feature } from "./webhooks/store.ts";

// ── Features ─────────────────────────────────────────────────────────────────

const owning_features = [items_feature, runs_feature, webhooks_feature, history_feature];

export const { store: settings_store, feature: settings_feature } = create_settings_feature(owning_features);

export const features = [settings_feature, ...owning_features];

export const sync_engine = create_sync_engine({ tables: features.flatMap((feature) => feature.tables), after_apply: forget_synced_changes });

export const setting_defaults = settings_store.defaults;

// ── Opening ──────────────────────────────────────────────────────────────────

// Whether opening would change the schema of a database that already holds data, so it can be backed up first.
export function needs_upgrade(database: SqlDatabase): boolean {
  const has_versions = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_versions'").get() !== undefined;
  if (!has_versions) return false;
  const version_of = database.prepare("SELECT version FROM schema_versions WHERE owner = ?");
  return features.some((feature) => ((version_of.get(feature.id) as { version: number } | undefined)?.version ?? 0) < feature.migrations.length);
}

// Brings an open connection up to date and sets sync to stamp every change; run once each time the database opens.
export function open_store(database: SqlDatabase): void {
  database.exec("PRAGMA foreign_keys = ON");
  // Each feature keeps its own schema version, so features grow apart without renumbering each other's steps.
  for (const feature of features) migrate(database, feature.migrations, { owner: feature.id });
  install_history(database);
  sync_engine.install(database);
  for (const feature of features) feature.on_open?.(database);
}

// ── Calls ────────────────────────────────────────────────────────────────────

const all_methods = Object.assign({}, ...features.map((feature) => feature.methods)) as typeof settings_feature.methods & typeof items_feature.methods & typeof runs_feature.methods & typeof history_feature.methods;

type Bound<Methods> = {
  [Name in keyof Methods]: Methods[Name] extends (database: SqlDatabase, ...args: infer Args) => infer Result ? (...args: Args) => Result : never;
};

// Every call the page can make, as it makes them, without the database.
export type DevMethods = Bound<typeof all_methods>;

export const method_names = Object.keys(all_methods) as (keyof DevMethods & string)[];

export { is_read_only };

// What every call does and takes, for programs other than the page.
export const dev_api = Object.assign({}, ...features.map((feature) => feature.api)) as ApiSpec<DevMethods>;

// The calls run on the database given; after each write the features catch up, the history records what it touched and
// on_change tells the other pages and devices.
export function bind_methods(database: () => SqlDatabase, on_change: () => void): DevMethods {
  const bound = method_names.map((name) => {
    const method = all_methods[name] as (database: SqlDatabase, ...args: unknown[]) => unknown;
    const call = (...args: unknown[]): unknown => {
      const result = method(database(), ...args);
      if (is_read_only(name)) return result;
      const after_write = () => {
        for (const feature of features) feature.after_write?.(database());
        record_history(database());
        on_change();
      };
      if (result instanceof Promise) return result.then((value: unknown) => (after_write(), value));
      after_write();
      return result;
    };
    return [name, call];
  });
  return Object.fromEntries(bound) as DevMethods;
}
