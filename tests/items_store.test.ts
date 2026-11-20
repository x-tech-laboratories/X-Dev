import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { check_item, empty_status, merge_status, read_status, status_limit } from "../src/shared/items/model.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

function open_methods() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return bind_methods(() => database, () => undefined);
}

const item = { title: "Board with swimlanes", repository: "x-tech-laboratories/X-Dev" };

// ============================================================================
// Rules
// ============================================================================

describe("an item's fields", () => {
  it("are trimmed, with a feature at triage when nothing else is given", () => {
    expect(check_item({ title: "  Board ", repository: " x-tech-laboratories/X-Dev " })).toEqual({
      id: undefined,
      title: "Board",
      kind: "feature",
      repository: "x-tech-laboratories/X-Dev",
      issue_number: null,
      body: "",
      stage: "triage",
    });
  });

  it("are refused in plain words when wrong", () => {
    expect(() => check_item({ ...item, title: " " })).toThrow("an item needs a title");
    expect(() => check_item({ ...item, repository: "X-Dev" })).toThrow('"X-Dev" is not a repository such as owner/name');
    expect(() => check_item({ ...item, kind: "chore" as never })).toThrow('"chore" is not feature or bug');
    expect(() => check_item({ ...item, issue_number: 0 })).toThrow("the issue number must be a whole number above 0");
    expect(() => check_item({ ...item, issue_number: 1.5 })).toThrow("the issue number must be a whole number above 0");
  });
});

describe("a status sheet", () => {
  it("reads back with every section, dropping ones it does not know", () => {
    expect(read_status('{"goal":"Lanes.","colour":"blue","decisions":7}')).toEqual({ ...empty_status(), goal: "Lanes." });
    expect(read_status("")).toEqual(empty_status());
  });

  it("replaces only the sections given, trimmed", () => {
    const sheet = merge_status({ ...empty_status(), goal: "Lanes." }, { current_state: "  Planned. " });
    expect(sheet).toEqual({ ...empty_status(), goal: "Lanes.", current_state: "Planned." });
  });

  it("refuses unknown sections and growing past its limit", () => {
    expect(() => merge_status(empty_status(), { log: "ran tests" })).toThrow('"log" is not a status section');
    expect(() => merge_status(empty_status(), { goal: "x".repeat(status_limit + 1) })).toThrow(/over its limit of 6000; shorten it/);
  });
});

// ============================================================================
// Store
// ============================================================================

describe("the items store", () => {
  it("adds an item, changes it by id and lists the open ones newest first", () => {
    const store = open_methods();
    const first = store.save_item(item, "2026-11-19T10:00:00.000Z");
    const second = store.save_item({ ...item, title: "Gates", kind: "bug", issue_number: 9 }, "2026-11-19T11:00:00.000Z");
    store.save_item({ ...item, id: first, title: "Swimlane board", stage: "plan" });

    expect(store.list_items().map((each) => [each.title, each.kind, each.stage])).toEqual([
      ["Gates", "bug", "triage"],
      ["Swimlane board", "feature", "plan"],
    ]);
    expect(store.get_item(second).issue_number).toBe(9);
  });

  it("keeps closed items out of the list unless asked, and opens them again", () => {
    const store = open_methods();
    const id = store.save_item(item);
    store.close_item(id, "2026-11-19T12:00:00.000Z");

    expect(store.list_items()).toEqual([]);
    expect(store.list_items(true)[0]!.closed_at).toBe("2026-11-19T12:00:00.000Z");
    store.reopen_item(id);
    expect(store.list_items()[0]!.closed_at).toBeNull();
  });

  it("updates the status sheet in place", () => {
    const store = open_methods();
    const id = store.save_item(item);
    store.update_item_status(id, { goal: "Lanes.", links: "PR #3" });
    store.update_item_status(id, { links: "PR #4" });

    expect(store.get_item(id).status).toEqual({ ...empty_status(), goal: "Lanes.", links: "PR #4" });
  });

  it("looks an item up by its repository and issue, the open one first, and gives null for none", () => {
    const methods = open_methods();
    const closed = methods.save_item({ ...item, issue_number: 12 }, "2026-11-01T00:00:00Z");
    methods.close_item(closed);
    const open = methods.save_item({ ...item, issue_number: 12 }, "2026-10-01T00:00:00Z");
    methods.save_item({ ...item, repository: "x-tech-laboratories/X-Libs", issue_number: 12 });

    expect(methods.lookup_item("X-Tech-Laboratories/x-dev", 12)?.id).toBe(open);
    methods.close_item(open);
    expect(methods.lookup_item("x-tech-laboratories/X-Dev", 12)?.id).toBe(closed);
    expect(methods.lookup_item("x-tech-laboratories/X-Dev", 13)).toBeNull();
  });

  it("refuses calls on an item that does not exist", () => {
    const store = open_methods();
    expect(() => store.get_item("missing")).toThrow("no item missing");
    expect(() => store.save_item({ ...item, id: "missing" })).toThrow("no item missing");
    expect(() => store.update_item_status("missing", {})).toThrow("no item missing");
    expect(() => store.close_item("missing")).toThrow("no item missing");
    expect(() => store.reopen_item("missing")).toThrow("no item missing");
    expect(() => store.delete_item("missing")).toThrow("no item missing");
  });
});
