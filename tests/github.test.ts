import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { best_match, find_or_open_issue } from "../src/server/github.ts";

const fake_gh = join(import.meta.dirname, "fixtures", "fake_gh.mjs");

describe("an item's issue", () => {
  it("is the open issue whose title is close enough, the closest winning", () => {
    expect(best_match("Board with swimlanes", [{ number: 1, title: "Swimlanes" }, { number: 2, title: "Swimlanes board" }])).toBe(2);
    expect(best_match("Board with swimlanes", [{ number: 3, title: "Faster sync" }])).toBeNull();
  });

  it("is linked when one is open already", async () => {
    expect(await find_or_open_issue({ repository: "owner/has-match", title: "Swimlanes on the board", body: "" }, fake_gh)).toEqual({ number: 5, opened: false });
  });

  it("is opened with the item's title and body when none matches", async () => {
    expect(await find_or_open_issue({ repository: "owner/empty", title: "Board with swimlanes", body: "One lane per item." }, fake_gh)).toEqual({ number: 42, opened: true });
    expect(JSON.parse(readFileSync(join(tmpdir(), "x-dev-fake-gh-owner-empty.json"), "utf8"))).toEqual({ title: "Board with swimlanes", body: "One lane per item." });
  });

  it("says why when GitHub cannot be reached", async () => {
    await expect(find_or_open_issue({ repository: "owner/broken", title: "Board", body: "" }, fake_gh)).rejects.toThrow("gh issue list failed: HTTP 404: Not Found");
    await expect(find_or_open_issue({ repository: "owner/empty", title: "Board", body: "" }, "/nonexistent/gh")).rejects.toThrow("is not installed or not on the PATH");
  });
});
