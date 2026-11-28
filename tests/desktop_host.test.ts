// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_CONNECTION_ID } from "@x-tech-laboratories/x-libs/connection_protocol";

import { connections_api_name, dev_api_name, device_api_name, events_api_name, listening_api_name } from "../src/shared/page_api.ts";
import { desktop_api, is_desktop } from "../src/web/hosts/desktop.ts";

const desktop = window as unknown as Record<string, unknown>;
const names = [dev_api_name, device_api_name, events_api_name, connections_api_name, listening_api_name];

afterEach(() => {
  for (const name of names) delete desktop[name];
});

function preload(current: string) {
  const changed = vi.fn();
  desktop[dev_api_name] = {};
  desktop[device_api_name] = { get_sync_status: vi.fn() };
  desktop[listening_api_name] = { get_peer_listening: vi.fn() };
  desktop[events_api_name] = { on: vi.fn((event: string, listener: () => void) => (event === "changed" && changed.mockImplementation(listener), () => undefined)) };
  desktop[connections_api_name] = { list_connections: vi.fn(async () => ({ connections: [], current })) };
  return changed;
}

describe("the desktop page", () => {
  it("gives sync and letting other devices connect while it works on this computer's daemon", async () => {
    expect(is_desktop()).toBe(false);
    preload(LOCAL_CONNECTION_ID);
    expect(is_desktop()).toBe(true);

    const api = await desktop_api();
    expect(api.device).toBe(desktop[device_api_name]);
    expect(api.listening).toBe(desktop[listening_api_name]);
    const heard = vi.fn();
    api.on_change(heard);
    expect((desktop[events_api_name] as { on: ReturnType<typeof vi.fn> }).on).toHaveBeenCalledWith("changed", heard);
  });

  it("gives neither while it works on another computer's daemon", async () => {
    preload("remote-1");
    const api = await desktop_api();
    expect(api.device).toBeNull();
    expect(api.listening).toBeUndefined();
  });
});
