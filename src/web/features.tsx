// The sections of the app, each a feature's page with its own settings, in the order the sidebar lists them.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import type { SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";

import { is_items_layout, ItemsView } from "./items/index.tsx";
import { RepositoriesView } from "./repositories/index.tsx";
import { RunsView } from "./runs/index.tsx";

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
  // Whether the view at these route parts keeps the window still so its own panes scroll, as the board does.
  contained?: (parts: string[]) => boolean;
  // What names one view among the route parts, so moving between parts that name the same view keeps its state.
  view_key?: (parts: string[]) => string;
}

export const page_features: PageFeature[] = [
  {
    id: "items",
    label: "Items",
    pages: [{ id: "list", label: "Items" }],
    view: (parts) => <ItemsView parts={parts} />,
    settings: () => [],
    contained: (parts) => !parts[0] || is_items_layout(parts[0]),
    view_key: (parts) => (!parts[0] || is_items_layout(parts[0]) ? "" : parts.join("/")),
  },
  { id: "runs", label: "Runs", pages: [{ id: "list", label: "Runs" }], view: () => <RunsView />, settings: () => [] },
  { id: "repositories", label: "Repositories", pages: [{ id: "list", label: "Repositories" }], view: () => <RepositoriesView />, settings: () => [] },
];
