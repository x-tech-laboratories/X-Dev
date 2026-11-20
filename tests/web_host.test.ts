// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import type { DevMethods } from "../src/shared/store.ts";
import { calls, data_watch, set_page_api } from "../src/web/api.ts";
import { web_api } from "../src/web/hosts/web.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Stands in for the browser's EventSource, which jsdom lacks; it never connects.
class QuietEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  addEventListener(): void {}
}

describe("the page's calls", () => {
  it("reach a host whose calls are a proxy with no list of names, and a write bumps the watch", async () => {
    const made: string[] = [];
    const host_calls = new Proxy({} as Client<DevMethods>, {
      get: (_target, name) => async () => {
        made.push(String(name));
        return name === "get_settings" ? { "history.keep_days": 180 } : undefined;
      },
    });
    set_page_api({ host: "web", calls: host_calls, device: null, on_change: () => () => undefined });

    const before = data_watch.version();
    expect(await calls().get_settings()).toEqual({ "history.keep_days": 180 });
    expect(data_watch.version()).toBe(before);
    await calls().set_setting("history.keep_days", 30);
    expect(data_watch.version()).toBe(before + 1);
    expect(made).toEqual(["get_settings", "set_setting"]);
  });

  it("go from the browser to the server by name with the arguments as a list", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ "history.keep_days": 30 }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("EventSource", QuietEventSource);
    set_page_api(await web_api());

    expect(await calls().get_settings()).toEqual({ "history.keep_days": 30 });
    expect(fetch).toHaveBeenCalledWith("api/call/get_settings", expect.objectContaining({ method: "POST", body: "[]" }));
  });

  it("reach the server's runner only when it runs agents and the user is an admin", async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === "api/abilities" ? { runner: true, stages: true } : "run-1"), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("EventSource", QuietEventSource);
    const api = await web_api();

    expect(await api.runner!.start_run("item-1", {})).toBe("run-1");
    expect(fetch).toHaveBeenCalledWith("api/runner/start_run", expect.objectContaining({ method: "POST", body: JSON.stringify(["item-1", {}]) }));
    expect(api.daemon_is_here).toBeUndefined();
  });

  it("leave the runner out where the server has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ runner: false, stages: true }), { status: 200 })));
    vi.stubGlobal("EventSource", QuietEventSource);

    expect((await web_api()).runner).toBeUndefined();
  });
});
