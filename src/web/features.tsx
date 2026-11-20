// The sections of the app, each a feature's page with its own settings, in the order the sidebar lists them.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import type { SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";

import { ItemsView } from "./items/index.tsx";

// ── Features ─────────────────────────────────────────────────────────────────

export interface FeatureSettingsProps {
  settings: Record<string, unknown>;
  set_setting: (key: string, value: unknown) => Promise<void>;
}

// One of a feature's pages, a row under it in the sidebar; the first is shown when none is named.
export interface FeaturePage {
  // The route's second part, such as "list" for #/items/list.
  id: string;
  label: string;
}

export interface PageFeature {
  // The route's first part, such as "items" for #/items.
  id: string;
  label: string;
  pages: FeaturePage[];
  view: (parts: string[]) => ReactNode;
  settings: (props: FeatureSettingsProps) => SettingsSection[];
}

export const page_features: PageFeature[] = [{ id: "items", label: "Items", pages: [{ id: "list", label: "Items" }], view: (parts) => <ItemsView parts={parts} />, settings: () => [] }];
