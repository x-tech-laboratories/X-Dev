// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { create_stage_files } from "../src/server/stage_files.ts";
import type { StagesMethods } from "../src/shared/stages/model.ts";
import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";

function as_client(methods: object): unknown {
  return Object.fromEntries(Object.entries(methods as Record<string, (...args: unknown[]) => unknown>).map(([name, call]) => [name, async (...args: unknown[]) => call(...args)]));
}

// The page's calls answered by a real store on a throwaway database, as the desktop app would, which needs no sign-in.
function fake_page(): DevMethods {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const methods = bind_methods(() => database, () => undefined);
  const stages = create_stage_files({ folder: mkdtempSync(join(tmpdir(), "x-dev-stages-")) }).methods;
  stages.add_default_stages();
  set_page_api({ host: "desktop", calls: as_client(methods) as Client<DevMethods>, device: null, stages: as_client(stages) as Client<StagesMethods>, on_change: () => () => undefined });
  return methods;
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

const item = { title: "Board with swimlanes", repository: "x-tech-laboratories/X-Dev" };

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
});

describe("items page", () => {
  it("is the page X-Dev opens on, in the board view, and says there are no items yet in the list", async () => {
    fake_page();
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Items" })).toBeTruthy();
    expect(await screen.findByText("No items on the board.")).toBeTruthy();
    go("#/items/list");

    expect(await screen.findByText("No items.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Items" })).toBeTruthy();
  });

  it("adds an item from its dialog, refusing one without a repository", async () => {
    const store = fake_page();
    render(<App />);
    go("#/items/list");

    fireEvent.click(await screen.findByRole("button", { name: "Add Item" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Board with swimlanes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Name the repository as owner/name.")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Repository"), { target: { value: "x-tech-laboratories/X-Dev" } });
    fireEvent.change(within(dialog).getByLabelText("Issue"), { target: { value: "4" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(store.list_items()).toHaveLength(1));
    expect(store.list_items()[0]).toMatchObject({ title: "Board with swimlanes", issue_number: 4, stage: "triage" });
  });

  it("lists each item with a link to its issue, and closes it", async () => {
    const store = fake_page();
    store.save_item({ ...item, issue_number: 4 });
    render(<App />);
    go("#/items/list");

    const link = await screen.findByRole("link", { name: "#4" });
    expect(link.getAttribute("href")).toBe("https://github.com/x-tech-laboratories/X-Dev/issues/4");
    fireEvent.click(screen.getByRole("button", { name: "Close Board with swimlanes" }));

    await waitFor(() => expect(store.list_items()).toEqual([]));
    expect(await screen.findByText("No items.")).toBeTruthy();
  });

  it("switches between board and list, keeping the search and remembering the choice on this device", async () => {
    const store = fake_page();
    store.save_item(item);
    store.save_item({ title: "Faster drawing", repository: "x-tech-laboratories/X-Libs" });
    render(<App />);

    expect(await screen.findByRole("grid", { name: "Board" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search items" }), { target: { value: "swimlanes" } });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Faster drawing" })).toBeNull());
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Layout" })).getByRole("radio", { name: "List" }));

    expect(window.location.hash).toBe("#/items/list");
    expect(await screen.findByRole("link", { name: "Board with swimlanes" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Faster drawing" })).toBeNull();
    expect((screen.getByRole("searchbox", { name: "Search items" }) as HTMLInputElement).value).toBe("swimlanes");
    expect(window.localStorage.getItem("x-dev-items-layout")).toBe(JSON.stringify("list"));

    go("#/items");
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.queryByRole("grid", { name: "Board" })).toBeNull();
  });

  it("lists finished items only when asked, and groups the list by repository", async () => {
    const store = fake_page();
    store.save_item(item);
    store.save_item({ title: "Faster drawing", repository: "x-tech-laboratories/X-Libs" });
    store.close_item(store.save_item({ title: "Old idea", repository: "x-tech-laboratories/X-Dev" }));
    render(<App />);
    go("#/items/list");

    expect(await screen.findByRole("link", { name: "Faster drawing" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Old idea" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show finished items" }));
    expect(await screen.findByRole("link", { name: "Old idea" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Group by repository" }));
    await waitFor(() => expect([...document.querySelectorAll(".group-row")].map((row) => row.textContent)).toEqual(["x-tech-laboratories/X-Dev 2", "x-tech-laboratories/X-Libs 1"]));
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "x-tech-laboratories/X-Libs" } });
    expect(screen.queryByRole("link", { name: "Board with swimlanes" })).toBeNull();
    expect(screen.getByRole("link", { name: "Faster drawing" })).toBeTruthy();
  });

  it("opens the board at the board's old address", async () => {
    fake_page().save_item(item);
    window.location.hash = "#/board";
    render(<App />);

    expect(await screen.findByRole("grid", { name: "Board" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Items" })).toBeTruthy();
  });
});

describe("sidebar", () => {
  it("lists Items, Runs and Repositories, then History last", async () => {
    fake_page();
    render(<App />);

    const tree = await screen.findByRole("tree", { name: "Sections" });
    expect(within(tree).getAllByRole("treeitem").map((row) => row.textContent)).toEqual(["Items", "Runs", "Repositories", "History"]);
  });
});

describe("history page", () => {
  it("lists the latest changes and brings a deleted item back", async () => {
    const store = fake_page();
    store.delete_item(store.save_item(item));
    render(<App />);
    go("#/history");

    const row = (await screen.findAllByRole("row")).find((each) => each.textContent?.includes("Deleted"))!;
    expect(row.textContent).toContain("Board with swimlanes");
    fireEvent.click(within(row).getByRole("button", { name: "Bring back" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(store.list_items().map((each) => each.title)).toEqual(["Board with swimlanes"]));
  });
});
