import { DatabaseSync } from "node:sqlite";

import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { EventStream } from "@x-tech-laboratories/x-libs/server/events";

import { register_dev_calls } from "../src/server/calls.ts";
import { open_store } from "../src/shared/store.ts";
import { desktop_setting_defaults, read_desktop_settings } from "../src/shared/desktop.ts";
import { items_label, tray_view, type TrayActions } from "../src/main/tray_menu.ts";

// ============================================================================
// Desktop settings
// ============================================================================

describe("the desktop settings", () => {
  it("are all on when none were saved", () => {
    expect(read_desktop_settings(null)).toEqual(desktop_setting_defaults);
    expect(desktop_setting_defaults).toEqual({ show_tray_icon: true, keep_running_in_background: true, start_at_login: true });
  });

  it("keep what was saved and default anything damaged", () => {
    expect(read_desktop_settings({ show_tray_icon: false, start_at_login: "yes" })).toEqual({ show_tray_icon: false, keep_running_in_background: true, start_at_login: true });
  });
});

// ============================================================================
// Tray menu
// ============================================================================

describe("the tray menu", () => {
  const actions = (): TrayActions => ({ open_route: vi.fn(), show: vi.fn(), quit: vi.fn(), quit_completely: vi.fn() });

  it("counts the open items in words", () => {
    expect(items_label(0)).toBe("0 open items");
    expect(items_label(1)).toBe("1 open item");
    expect(items_label(3)).toBe("3 open items");
  });

  it("lists the open items, then the commands", () => {
    const view = tray_view({ open_items: 2 }, actions());

    expect(view.rows.map((row) => (row.kind === "item" ? row.label : "—"))).toEqual(["2 open items", "—", "Show X-Dev", "Quit", "Quit completely"]);
    expect(view.tooltip).toBe("X-Dev\n2 open items");
  });

  it("opens the items from their row and quits completely from its own", () => {
    const done = actions();
    for (const row of tray_view({ open_items: 1 }, done).rows) if (row.kind === "item") row.run();

    expect(done.open_route).toHaveBeenCalledWith("#/items");
    expect(done.quit_completely).toHaveBeenCalled();
  });
});

// ============================================================================
// Data calls over HTTP
// ============================================================================

describe("the data calls over HTTP", () => {
  it("send a call's text answer as JSON, so the window can read it", async () => {
    const app = fastify();
    const database = new DatabaseSync(":memory:");
    open_store(database);
    register_dev_calls(app, () => database, new EventStream());

    const saved = await app.inject({ method: "POST", url: "/call/save_item", payload: [{ title: "Board", repository: "x-tech-laboratories/X-Dev" }] });

    expect(saved.headers["content-type"]).toContain("application/json");
    expect(typeof JSON.parse(saved.body)).toBe("string");
    await app.close();
  });

  it("take the arguments by name as well", async () => {
    const app = fastify();
    const database = new DatabaseSync(":memory:");
    open_store(database);
    register_dev_calls(app, () => database, new EventStream());

    await app.inject({ method: "POST", url: "/call/save_item", payload: { item: { title: "Board", repository: "x-tech-laboratories/X-Dev" } } });
    const listed = await app.inject({ method: "POST", url: "/call/list_items", payload: { include_closed: false } });

    expect(JSON.parse(listed.body)).toHaveLength(1);
    await app.close();
  });
});
