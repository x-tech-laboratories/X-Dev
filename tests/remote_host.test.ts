import { describe, expect, it, vi } from "vitest";

import { LoginNeeded } from "@x-tech-laboratories/x-libs/web/states";

import type { RunnerMethods } from "../src/shared/runs/runner.ts";
import { call_remote, follow_remote, parse_remote_event, read_abilities, remote_table, type RemoteLink } from "../src/web/hosts/remote.ts";

const daemon = { address: "https://dev.example.org", token: "device-token" };

function link_with(fetch: typeof globalThis.fetch, chosen: typeof daemon | null = daemon): RemoteLink {
  return { daemon: () => chosen, client_id: () => "client-1", fetch };
}

describe("a page's calls to a daemon elsewhere", () => {
  it("start runs on the daemon, with this device's token, and never on the device", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify("run-1"), { status: 200 }));
    const runner = remote_table<RunnerMethods>(link_with(fetch), "/api/runner/");

    expect(await runner.start_run("item-1", { stage: "plan" })).toBe("run-1");
    expect(await runner.answer_run("run-1", "Lanes.")).toBe("run-1");

    expect(fetch).toHaveBeenNthCalledWith(1, "https://dev.example.org/api/runner/start_run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer device-token", "x-client-id": "client-1" },
      body: JSON.stringify(["item-1", { stage: "plan" }]),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, "https://dev.example.org/api/runner/answer_run", expect.objectContaining({ body: JSON.stringify(["run-1", "Lanes."]) }));
  });

  it("answer nothing for an empty reply, and pass on the daemon's refusal in its words", async () => {
    const replies = [new Response(null, { status: 204 }), new Response(JSON.stringify({ error: "that run is not waiting for answers" }), { status: 500 }), new Response("plain words", { status: 403 })];
    const link = link_with(vi.fn(async () => replies.shift()!));

    expect(await call_remote(link, "/api/call/set_setting", ["history.keep_days", 30])).toBeUndefined();
    await expect(call_remote(link, "/api/runner/answer_run", ["run-1", "Yes."])).rejects.toThrow("that run is not waiting for answers");
    await expect(call_remote(link, "/api/stages/list_stages", [])).rejects.toThrow("plain words");
  });

  it("asks to sign in again when the token is refused, and to add a daemon when there is none", async () => {
    await expect(call_remote(link_with(vi.fn(async () => new Response("", { status: 401 }))), "/api/call/list_items", [])).rejects.toBeInstanceOf(LoginNeeded);
    await expect(call_remote(link_with(vi.fn(), null), "/api/call/list_items", [])).rejects.toThrow("Settings → Connections");
  });

  it("says when the daemon is out of reach", async () => {
    await expect(call_remote(link_with(vi.fn(async () => Promise.reject(new TypeError("fetch failed")))), "/api/call/list_items", [])).rejects.toThrow("did not answer");
  });

  it("read what the daemon lets this device do, and nothing when it cannot be asked", async () => {
    expect(await read_abilities(link_with(vi.fn(async () => new Response(JSON.stringify({ runner: true, stages: true })))))).toEqual({ runner: true, stages: true });
    expect(await read_abilities(link_with(vi.fn(async () => new Response("", { status: 401 }))))).toEqual({ runner: false, stages: false });
    expect(await read_abilities(link_with(vi.fn(), null))).toEqual({ runner: false, stages: false });
  });
});

describe("a daemon's change events", () => {
  it("are read from the stream with the token", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: hello\ndata: client-9\n\n: keep-alive\n\nevent: changed\ndata: null\n\n"));
        controller.close();
      },
    });
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    const seen: string[] = [];
    const on_connect = vi.fn();

    const stop = follow_remote(link_with(fetch), (event, data) => seen.push(`${event}:${data}`), { retry_ms: 60_000, on_connect });
    await vi.waitFor(() => expect(seen).toEqual(["hello:client-9", "changed:null"]));
    stop();

    expect(on_connect).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://dev.example.org/api/events", expect.objectContaining({ headers: { accept: "text/event-stream", authorization: "Bearer device-token" } }));
  });

  it("are parsed one block at a time", () => {
    expect(parse_remote_event("event: changed\ndata: a\ndata: b")).toEqual({ event: "changed", data: "a\nb" });
    expect(parse_remote_event("data: plain")).toEqual({ event: "message", data: "plain" });
    expect(parse_remote_event(": comment")).toBeNull();
  });
});
