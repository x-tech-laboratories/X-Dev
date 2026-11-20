// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { DatabaseSync } from "node:sqlite";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { empty_mirror, set_item_github } from "../src/shared/items/github.ts";
import type { RunnerMethods } from "../src/shared/runs/runner.ts";
import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { PullRequestPanel } from "../src/web/items/PullRequestPanel.tsx";

function as_client(methods: object): unknown {
  return Object.fromEntries(Object.entries(methods as Record<string, (...args: unknown[]) => unknown>).map(([name, call]) => [name, async (...args: unknown[]) => call(...args)]));
}

// The panel on a real store, with a runner whose sync is recorded when given.
function fake_page(with_runner = true) {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const runner = { sync_github: vi.fn(async () => "") };
  set_page_api({
    host: "desktop",
    calls: as_client(store) as unknown as Client<DevMethods>,
    device: null,
    ...(with_runner ? { runner: as_client(runner) as unknown as Client<RunnerMethods> } : {}),
    on_change: () => () => undefined,
  });
  return { database, store, runner };
}

afterEach(cleanup);

describe("the pull request panel", () => {
  it("shows the pull request, its state and each check with how it went", async () => {
    const { database, store } = fake_page();
    const id = store.save_item({ title: "Board", repository: "owner/repo", issue_number: 7 });
    const checks = [
      { name: "test", workflow: "CI", bucket: "pass" as const, link: "https://github.com/owner/repo/actions/runs/1" },
      { name: "lint", workflow: "", bucket: "pending" as const, link: "" },
    ];
    set_item_github(database, id, { pull_request: { number: 12, url: "https://github.com/owner/repo/pull/12", state: "open", draft: false, checks, changed_at: "2026-11-20T10:00:00.000Z" } });
    render(<PullRequestPanel item={store.get_item(id)} />);

    expect((await screen.findByRole("link", { name: "#12" })).getAttribute("href")).toBe("https://github.com/owner/repo/pull/12");
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("CI / test")).toBeTruthy();
    expect(screen.getByText("Passed")).toBeTruthy();
    expect(screen.getByText("lint")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Details of test" }).getAttribute("href")).toBe("https://github.com/owner/repo/actions/runs/1");
  });

  it("says what failed last time, and syncs again on the button", async () => {
    const { database, store, runner } = fake_page();
    const id = store.save_item({ title: "Board", repository: "owner/repo", issue_number: 7 });
    set_item_github(database, id, { mirror: { ...empty_mirror(), problem: "gh issue view failed: error connecting to api.github.com" } });
    render(<PullRequestPanel item={store.get_item(id)} />);

    expect((await screen.findByRole("alert")).textContent).toContain("error connecting to api.github.com");
    expect(screen.getByText(/No pull request yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sync to GitHub" }));

    await waitFor(() => expect(runner.sync_github).toHaveBeenCalledWith(id));
  });

  it("is left out for an item with no issue, and has no button without a runner", async () => {
    const { store } = fake_page(false);
    const bare = store.save_item({ title: "Board", repository: "owner/repo" });
    const { container } = render(<PullRequestPanel item={store.get_item(bare)} />);
    expect(container.textContent).toBe("");
    cleanup();

    const linked = store.save_item({ title: "Board", repository: "owner/repo", issue_number: 7 });
    render(<PullRequestPanel item={store.get_item(linked)} />);
    expect(await screen.findByText(/No pull request yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sync to GitHub" })).toBeNull();
  });
});
