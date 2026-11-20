// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";

// The page's calls answered by a real store on a throwaway database, as the desktop app would, which needs no sign-in.
function fake_page(): DevMethods {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const methods = bind_methods(() => database, () => undefined);
  const calls = Object.fromEntries(Object.entries(methods).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "desktop", calls: calls as unknown as Client<DevMethods>, device: null, on_change: () => () => undefined });
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
  it("says there are no items yet, the board being the page X-Dev opens on", async () => {
    fake_page();
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Board" })).toBeTruthy();
    go("#/items");

    expect(await screen.findByRole("heading", { level: 1, name: "Items" })).toBeTruthy();
    expect(await screen.findByText("No items.")).toBeTruthy();
  });

  it("adds an item from its dialog, refusing one without a repository", async () => {
    const store = fake_page();
    render(<App />);
    go("#/items");

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
    go("#/items");

    const link = await screen.findByRole("link", { name: "#4" });
    expect(link.getAttribute("href")).toBe("https://github.com/x-tech-laboratories/X-Dev/issues/4");
    fireEvent.click(screen.getByRole("button", { name: "Close Board with swimlanes" }));

    await waitFor(() => expect(store.list_items()).toEqual([]));
    expect(await screen.findByText("No items.")).toBeTruthy();
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
