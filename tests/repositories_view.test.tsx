// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import type { DesktopMethods } from "../src/shared/desktop.ts";
import { runner_setting_defaults, type RunnerMethods } from "../src/shared/runs/runner.ts";
import { bind_methods, open_store, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";

function as_client(methods: object): unknown {
  return Object.fromEntries(Object.entries(methods as Record<string, (...args: unknown[]) => unknown>).map(([name, call]) => [name, async (...args: unknown[]) => call(...args)]));
}

// The page on a real store, with a runner and a desktop whose calls are recorded.
function fake_page({ signed_in = true, is_here = true } = {}) {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  const repositories: Record<string, string> = { "x-tech-laboratories/X-Dev": "/checkouts/X-Dev" };
  const runner = {
    get_runner: vi.fn(() => ({ settings: { ...runner_setting_defaults, repositories: { ...repositories } }, running_run_id: null })),
    add_repository: vi.fn(async (folder: string) => {
      repositories["x-tech-laboratories/X-Libs"] = folder;
      return "x-tech-laboratories/X-Libs";
    }),
    remove_repository: vi.fn((name: string) => void delete repositories[name]),
    get_github: vi.fn(async () => (signed_in ? { signed_in: true, account: "someone", problem: "" } : { signed_in: false, account: "", problem: "" })),
    sign_in_github: vi.fn(async () => ({ code: "WXYZ-9876", url: "https://github.com/login/device" })),
    sign_out_github: vi.fn(async () => undefined),
  };
  const desktop = {
    pick_folder: vi.fn(() => "/checkouts/X-Libs"),
    get_desktop_settings: vi.fn(() => ({ show_tray_icon: true, keep_running_in_background: true, start_at_login: true })),
    set_desktop_setting: vi.fn(),
    quit_completely: vi.fn(),
  };
  set_page_api({
    host: "desktop",
    calls: as_client(store) as Client<DevMethods>,
    device: null,
    runner: as_client(runner) as Client<RunnerMethods>,
    desktop: as_client(desktop) as Client<DesktopMethods>,
    ...(is_here ? { daemon_is_here: true } : {}),
    on_change: () => () => undefined,
  });
  return { store, runner, desktop };
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

afterEach(cleanup);

describe("the repositories page", () => {
  it("lists each repository with its checkout and open items", async () => {
    const { store } = fake_page();
    store.save_item({ title: "Swimlanes", repository: "x-tech-laboratories/X-Dev", issue_number: 1 });
    render(<App />);
    go("#/repositories");

    const row = (await screen.findByRole("link", { name: "x-tech-laboratories/X-Dev" })).closest("tr")!;
    expect(within(row).getByText("/checkouts/X-Dev")).toBeTruthy();
    expect(within(row).getByText("1")).toBeTruthy();
  });

  it("adds a checkout picked in the folder dialog", async () => {
    const { runner, desktop } = fake_page();
    render(<App />);
    go("#/repositories");

    fireEvent.click(await screen.findByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(desktop.pick_folder).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText("Checkout folder") as HTMLInputElement).value).toBe("/checkouts/X-Libs"));
    fireEvent.click(screen.getByRole("button", { name: "Add Repository" }));

    await waitFor(() => expect(runner.add_repository).toHaveBeenCalledWith("/checkouts/X-Libs"));
    expect(await screen.findByRole("link", { name: "x-tech-laboratories/X-Libs" })).toBeTruthy();
  });

  it("takes a typed folder when the daemon runs on another computer, whose dialog it cannot open", async () => {
    const { runner, desktop } = fake_page({ is_here: false });
    render(<App />);
    go("#/repositories");

    fireEvent.change(await screen.findByLabelText("Checkout folder"), { target: { value: "/checkouts/X-Libs" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Repository" }));

    await waitFor(() => expect(runner.add_repository).toHaveBeenCalledWith("/checkouts/X-Libs"));
    expect(screen.queryByRole("button", { name: "Choose…" })).toBeNull();
    expect(desktop.pick_folder).not.toHaveBeenCalled();
  });

  it("forgets a repository after asking", async () => {
    const { runner } = fake_page();
    render(<App />);
    go("#/repositories");

    fireEvent.click(await screen.findByRole("button", { name: "Forget x-tech-laboratories/X-Dev" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(runner.remove_repository).toHaveBeenCalledWith("x-tech-laboratories/X-Dev"));
  });
});

describe("the GitHub settings", () => {
  it("show the account gh is signed into, and sign it out after asking", async () => {
    const { runner } = fake_page();
    render(<><SettingsView /><Dialogs /></>);

    fireEvent.click(await screen.findByRole("button", { name: "Sign Out" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sign Out" }));
    await waitFor(() => expect(runner.sign_out_github).toHaveBeenCalled());
    expect(screen.getByText("Signed in as someone")).toBeTruthy();
  });

  it("sign in by showing the one-time code and GitHub's device page", async () => {
    const { runner } = fake_page({ signed_in: false });
    render(<SettingsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign In to GitHub" }));
    expect(await screen.findByText("WXYZ-9876")).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub's device page" }).getAttribute("href")).toBe("https://github.com/login/device");
    expect(runner.sign_in_github).toHaveBeenCalled();
  });
});
