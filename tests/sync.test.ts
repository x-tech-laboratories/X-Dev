import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bind_methods, open_store, sync_engine } from "../src/shared/store.ts";

function open_device(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return database;
}

// Sends one device's unpushed changes to another, as an exchange through the server does.
function push(from: DatabaseSync, to: DatabaseSync): void {
  const outgoing = sync_engine.collect_unpushed_changes(from);
  sync_engine.write_state(from, { pushed_seq: outgoing.up_to_seq });
  sync_engine.apply_changes(to, outgoing.changes);
}

describe("sync between devices", () => {
  it("carries items, their status sheets and their closing", () => {
    const laptop = open_device();
    const desktop = open_device();
    const on_laptop = bind_methods(() => laptop, () => undefined);
    const on_desktop = bind_methods(() => desktop, () => undefined);

    const id = on_laptop.save_item({ title: "Board with swimlanes", repository: "x-tech-laboratories/X-Dev", issue_number: 4 });
    on_laptop.update_item_status(id, { current_state: "Planned." });
    push(laptop, desktop);
    on_desktop.close_item(id);
    push(desktop, laptop);

    expect(on_desktop.get_item(id)).toMatchObject({ title: "Board with swimlanes", issue_number: 4, status: { current_state: "Planned." } });
    expect(on_laptop.list_items()).toEqual([]);
    expect(on_laptop.list_items(true)[0]!.closed_at).not.toBeNull();
  });
});
