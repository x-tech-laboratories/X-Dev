// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionClient } from "@x-tech-laboratories/x-libs/connection_protocol";
import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { remote_access_defaults, type RemoteAccessMethods, type RemoteAccessStatus } from "../src/shared/remote_access.ts";
import type { RunnerMethods } from "../src/shared/runs/runner.ts";
import { setting_defaults, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";
import { read_notice_kinds } from "../src/web/hosts/android.ts";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";

afterEach(cleanup);

const calls = { get_settings: vi.fn(async () => setting_defaults), list_items: vi.fn(async () => []), list_stage_runs: vi.fn(async () => []), list_proposals: vi.fn(async () => []) } as unknown as Client<DevMethods>;

function fake_connections(current: string | null): ConnectionClient {
  const view = { connections: [{ id: "local", name: "This computer", kind: "local" as const, address: "", user: "" }, { id: "home", name: "Workstation", kind: "remote" as const, address: "https://dev.example.org:7760", user: "root" }], current };
  return {
    list_connections: vi.fn(async () => view),
    add_connection: vi.fn(async () => view),
    rename_connection: vi.fn(async () => view),
    remove_connection: vi.fn(async () => view),
    choose_connection: vi.fn(async () => ({ ...view, current: "home" })),
  };
}

function fake_remote(): Client<RemoteAccessMethods> & { status: RemoteAccessStatus } {
  const status: RemoteAccessStatus = { settings: remote_access_defaults, admins: [], listening: "", problem: "" };
  const remote = {
    status,
    get_remote_access: vi.fn(async () => remote.status),
    set_remote_access: vi.fn(async (settings) => (remote.status = { ...remote.status, settings, listening: settings.enabled ? "http://0.0.0.0:7760" : "" })),
    set_remote_admin: vi.fn(async (name: string) => (remote.status = { ...remote.status, admins: [name] })),
    remove_remote_admin: vi.fn(async () => (remote.status = { ...remote.status, admins: [] })),
  };
  return remote as never;
}

describe("connections", () => {
  it("lists This computer and the daemons elsewhere, and switches to one", async () => {
    const connections = fake_connections("local");
    set_page_api({ host: "desktop", calls, device: null, connections, on_change: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    expect(await screen.findByText("This computer")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(connections.choose_connection).toHaveBeenCalledWith("home"));
  });

  it("start a phone with no daemon on adding one", async () => {
    const connections = { ...fake_connections(null), list_connections: vi.fn(async () => ({ connections: [], current: null })) };
    set_page_api({ host: "android", calls, device: null, connections, on_change: () => () => undefined });
    render(<><App /><Dialogs /></>);

    expect(await screen.findByRole("heading", { name: "Connect to X-Dev" })).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Daemon address"), { target: { value: "dev.example.org:7760" } });
    fireEvent.change(screen.getByLabelText("User name"), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a long enough password" } });
    fireEvent.click(screen.getByRole("button", { name: "Add daemon" }));

    await waitFor(() => expect(connections.add_connection).toHaveBeenCalledWith("dev.example.org:7760", { name: "root", password: "a long enough password" }, ""));
  });
});

describe("letting other devices connect", () => {
  it("adds an admin, then turns listening on", async () => {
    const remote = fake_remote();
    set_page_api({ host: "desktop", calls, device: null, remote_access: remote, daemon_is_here: true, on_change: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    fireEvent.change(await screen.findByLabelText(/^Admin name/), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "a long enough password" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Admin" }));
    await waitFor(() => expect(remote.set_remote_admin).toHaveBeenCalledWith("root", "a long enough password"));

    fireEvent.click(screen.getByRole("switch", { name: "Let other devices connect" }));
    await waitFor(() => expect(remote.set_remote_access).toHaveBeenCalledWith({ ...remote_access_defaults, enabled: true }));
    expect(await screen.findByText("Listening on http://0.0.0.0:7760")).toBeTruthy();
  });

  it("saves a changed address and port", async () => {
    const remote = fake_remote();
    set_page_api({ host: "desktop", calls, device: null, remote_access: remote, daemon_is_here: true, on_change: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    fireEvent.change(await screen.findByLabelText(/^Address/), { target: { value: "10.0.0.2" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "7761" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(remote.set_remote_access).toHaveBeenCalledWith({ ...remote_access_defaults, host: "10.0.0.2", port: 7761 }));
  });

  it("is not offered while the window uses a daemon elsewhere", async () => {
    set_page_api({ host: "desktop", calls, device: null, connections: fake_connections("home"), on_change: () => () => undefined });
    render(<SettingsView />);

    await screen.findByText("Workstation");
    expect(screen.queryByRole("switch", { name: "Let other devices connect" })).toBeNull();
  });
});

describe("runs on a daemon elsewhere", () => {
  it("show the programs and permissions without letting them change", async () => {
    const runner = {
      get_runner: vi.fn(async () => ({ settings: { repositories: {}, permission_mode: "auto", claude_program: "claude", describer_model: "haiku", gh_program: "gh" }, running_run_id: null })),
      get_github: vi.fn(async () => ({ signed_in: false, account: "", problem: "" })),
      set_runner_setting: vi.fn(),
    } as unknown as Client<RunnerMethods>;
    set_page_api({ host: "android", calls, device: null, runner, on_change: () => () => undefined });
    render(<SettingsView />);

    expect(await screen.findByText("Auto: each action is checked")).toBeTruthy();
    expect(screen.getByLabelText("Claude program")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("GitHub program")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Describing model")).toHaveProperty("disabled", false);
    expect(screen.getByText(/gives a code to enter on GitHub's device page from this device/)).toBeTruthy();
  });
});

describe("a phone's notifications", () => {
  it("are all on until switched off, kept on the phone", async () => {
    let saved: Record<string, boolean> = read_notice_kinds(null);
    const notice_kinds = { get: vi.fn(async () => saved as never), set: vi.fn(async (kind: string, on: boolean) => void (saved = { ...saved, [kind]: on })) };
    set_page_api({ host: "android", calls, device: null, notice_kinds, on_change: () => () => undefined });
    render(<SettingsView />);

    fireEvent.click(await screen.findByRole("switch", { name: "A run finished" }));

    await waitFor(() => expect(notice_kinds.set).toHaveBeenCalledWith("run_finished", false));
    expect(saved.run_asked).toBe(true);
    expect(read_notice_kinds('{"run_failed": false}')).toMatchObject({ run_failed: false, run_asked: true });
    expect(read_notice_kinds("not json").run_finished).toBe(true);
  });
});
