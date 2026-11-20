import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { prune_history } from "../src/shared/history/store.ts";
import { bind_methods, open_store, sync_engine } from "../src/shared/store.ts";

function open_methods() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return { database, store: bind_methods(() => database, () => undefined) };
}

const item = { title: "Board with swimlanes", repository: "x-tech-laboratories/X-Dev" };

describe("history", () => {
  it("keeps a version of an item for every change to it and brings a deleted one back whole", () => {
    const { store } = open_methods();
    const id = store.save_item(item);
    store.update_item_status(id, { goal: "One lane per item." });

    const versions = store.list_item_history("item", id);
    expect(versions.map((version) => version.change)).toEqual(["edited", "created"]);
    expect(versions[0]).toMatchObject({ kind: "item", kind_label: "Item", item_name: "Board with swimlanes", summary: "x-tech-laboratories/X-Dev at triage", origin: "here" });

    store.delete_item(id);
    expect(store.list_items()).toEqual([]);
    const deleted = store.list_recent_changes(10).find((change) => change.item_id === id)!;
    expect(deleted.change).toBe("deleted");

    store.restore_item_version("item", deleted.id);
    expect(store.get_item(id).status.goal).toBe("One lane per item.");
    expect(store.list_item_history("item", id)[0]!.change).toBe("restored");
  });

  it("puts an edited item back as an earlier version had it", () => {
    const { store } = open_methods();
    const id = store.save_item(item);
    store.save_item({ ...item, id, title: "Swimlane board" });

    const [renamed, created] = store.list_item_history("item", id);
    expect(renamed!.item_name).toBe("Swimlane board");
    store.restore_item_version("item", created!.id);
    expect(store.get_item(id).title).toBe("Board with swimlanes");
  });

  it("syncs the versions, and records a change only on the device that made it", () => {
    const laptop = open_methods();
    const desktop = open_methods();
    const id = laptop.store.save_item(item);

    sync_engine.apply_changes(desktop.database, sync_engine.collect_unpushed_changes(laptop.database).changes);
    expect(desktop.store.list_item_history("item", id).map((version) => [version.change, version.origin])).toEqual([["created", "elsewhere"]]);

    desktop.store.save_item({ title: "Another", repository: "x-tech-laboratories/X-Libs" });
    expect(desktop.store.list_item_history("item", id)).toHaveLength(1);
  });

  it("prunes versions older than the days kept, keeping each item's newest", () => {
    const { database, store } = open_methods();
    const id = store.save_item(item);
    store.save_item({ ...item, id, title: "Swimlane board" });
    store.set_setting("history.keep_days", 30);

    prune_history(database, Date.now() + 60 * 24 * 60 * 60 * 1000);
    expect(store.list_item_history("item", id).map((version) => version.item_name)).toEqual(["Swimlane board"]);
  });
});
