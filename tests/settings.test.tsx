// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { desktop_setting_defaults, type DesktopMethods } from "../src/shared/desktop.ts";
import type { DeviceMethods } from "../src/shared/page_api.ts";
import { setting_defaults, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";

afterEach(cleanup);

function fake_calls(saved: Record<string, unknown>): Client<DevMethods> {
  return {
    get_settings: vi.fn(async () => ({ ...setting_defaults, ...saved })),
    set_setting: vi.fn(async (key: string, value: unknown) => {
      saved[key] = value;
    }),
  } as unknown as Client<DevMethods>;
}

const off = { state: "off", device: "ABCDEFGHIJKLMNOP", name: "X-Dev on laptop", addresses: [], peers: [], last_synced_at: "", pending_changes: 0, error: "" } as const;

describe("settings", () => {
  it("shows how long history is kept and saves a change", async () => {
    const calls = fake_calls({});
    set_page_api({ host: "web", calls, device: null, on_change: () => () => undefined });
    render(<SettingsView />);

    fireEvent.click(await screen.findByRole("button", { name: "More keep changes for" }));
    await waitFor(() => expect(calls.set_setting).toHaveBeenCalledWith("history.keep_days", 181));
    expect(screen.queryByText("Sync")).toBeNull();
  });

  it("offers sync on a device, pairs it with another device's code, and lets other devices connect on the desktop", async () => {
    const device = {
      get_sync_status: vi.fn(async () => off),
      pair_device: vi.fn(async () => ({ ...off, state: "idle" })),
    } as unknown as Client<DeviceMethods>;
    const listening = {
      get_peer_listening: vi.fn(async () => ({ on: false, port: 3934, addresses: [], error: "" })),
      set_peer_listening: vi.fn(async (on: boolean, port?: number) => ({ on, port: port ?? 3934, addresses: [], error: "" })),
    };
    set_page_api({ host: "desktop", calls: fake_calls({}), device, listening, on_change: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    fireEvent.change(await screen.findByPlaceholderText("x-sync:…"), { target: { value: "x-sync:from-the-server" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(device.pair_device).toHaveBeenCalledWith("x-sync:from-the-server"));
    fireEvent.click(await screen.findByRole("switch", { name: "Let other devices connect" }));
    await waitFor(() => expect(listening.set_peer_listening).toHaveBeenCalledWith(true, 3934));
  });

  it("shows the server's backups in a browser and takes one by hand", async () => {
    const taken = { name: "dev-2026-11-10T09-30-00Z.db", taken_at: "2026-11-10T09:30:00Z", is_automatic: false, size_bytes: 4096 };
    const backups = {
      list_backups: vi.fn(async () => [taken]),
      create_backup: vi.fn(async () => taken),
      restore_backup: vi.fn(),
      remove_backup: vi.fn(),
      get_backup_schedule: vi.fn(async () => ({ automatic: true, to_keep: 14 })),
      set_backup_schedule: vi.fn(),
    };
    set_page_api({ host: "web", calls: fake_calls({}), device: null, backups, on_change: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    expect((await screen.findAllByText("Server")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Backups")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Sync")).toBeNull();
    await waitFor(() => expect(backups.list_backups).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Back up" }));
    await waitFor(() => expect(backups.create_backup).toHaveBeenCalled());
  });

  it("switches each kind of notification on this computer, and shows none in a browser", async () => {
    const desktop = {
      get_desktop_settings: vi.fn(async () => desktop_setting_defaults),
      set_desktop_setting: vi.fn(async () => undefined),
      quit_completely: vi.fn(),
      pick_folder: vi.fn(),
    } as unknown as Client<DesktopMethods>;
    set_page_api({ host: "desktop", calls: fake_calls({}), device: null, desktop, on_change: () => () => undefined });
    render(<SettingsView />);

    fireEvent.click(await screen.findByRole("switch", { name: "A run asked questions" }));
    await waitFor(() => expect(desktop.set_desktop_setting).toHaveBeenCalledWith("notify_run_asked", false));
    expect(screen.getByRole("switch", { name: "A pull request's checks finished" })).toBeTruthy();
    cleanup();

    set_page_api({ host: "web", calls: fake_calls({}), device: null, on_change: () => () => undefined });
    render(<SettingsView />);
    await screen.findByRole("button", { name: "More keep changes for" });
    expect(screen.queryByRole("switch", { name: "A run finished" })).toBeNull();
  });
});
