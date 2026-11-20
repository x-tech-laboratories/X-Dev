import { default_backup_schedule } from "@x-tech-laboratories/x-libs/backups";
import { describe, expect, it } from "vitest";

import { read_schedule } from "../src/shared/backups.ts";
import { app_link, route_of_link } from "../src/shared/links.ts";

// ============================================================================
// Links
// ============================================================================

describe("the app's links", () => {
  it("turns a route into a link and back, refusing text that is not one", () => {
    expect(app_link("#/items")).toBe("x-dev://items");
    expect(app_link("runs")).toBe("x-dev://runs");

    expect(route_of_link("x-dev://items/abc/")).toBe("#/items/abc");
    expect(route_of_link("X-DEV://runs")).toBe("#/runs");
    expect(route_of_link("https://example.org")).toBeNull();
  });
});

// ============================================================================
// Backup schedule
// ============================================================================

describe("a saved backup schedule", () => {
  it("keeps what is valid and falls back to the default for the rest", () => {
    expect(read_schedule({ automatic: false, to_keep: 4.4 })).toEqual({ automatic: false, to_keep: 4 });

    expect(read_schedule({ automatic: "yes", to_keep: -1 })).toEqual(default_backup_schedule);
    expect(read_schedule(null)).toEqual(default_backup_schedule);
  });
});
