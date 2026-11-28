// Settings every device shares, kept as JSON values by key in the X-Libs settings store, each feature declaring its own keys.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_settings_store, type SettingSpec } from "@x-tech-laboratories/x-libs/settings";

import { define_feature } from "./feature.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export type { Settings } from "@x-tech-laboratories/x-libs/settings";

// ── Store ────────────────────────────────────────────────────────────────────

// The settings feature over every other feature's settings, so they share one table and one set of calls.
export function create_settings_feature(features: readonly { settings?: Record<string, SettingSpec> }[]) {
  const store = create_settings_store(
    features.map((feature) => feature.settings ?? {}),
    {
      app: { id: "x-dev", name: "X-Dev" },
      descriptions: { get_settings: "Every setting by key, such as history.keep_days, the ones never set at their defaults." },
      key_example: "history.keep_days",
    },
  );
  const feature = define_feature({ id: store.id, migrations: store.migrations, tables: store.tables, methods: { ...store.methods }, api: store.api });
  return { store, feature };
}
