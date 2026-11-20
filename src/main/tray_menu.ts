// What the tray shows, worked out apart from Electron: how many items are open, and the window and quit commands.

// ── Imports ──────────────────────────────────────────────────────────────────

import { app_rows, tray_groups, type TrayRow, type TrayView } from "@x-tech-laboratories/x-libs/electron/tray";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface TrayState {
  open_items: number;
}

// What the tray's rows do.
export interface TrayActions {
  open_route: (route: string) => void;
  show: () => void;
  quit: () => void;
  quit_completely: () => void;
}

// ── Menu ─────────────────────────────────────────────────────────────────────

export function items_label(count: number): string {
  return count === 1 ? "1 open item" : `${count} open items`;
}

// The open items, which opens the board, then showing the window, quitting the window and tray, and quitting the daemon too.
export function tray_view(state: TrayState, actions: TrayActions): TrayView {
  const item_rows: TrayRow[] = [{ kind: "item", label: items_label(state.open_items), run: () => actions.open_route("#/items") }];
  return {
    tooltip: `X-Dev\n${items_label(state.open_items)}`,
    rows: tray_groups(item_rows, app_rows({ app_name: "X-Dev", show: actions.show, quit: actions.quit, quit_completely: actions.quit_completely })),
  };
}
