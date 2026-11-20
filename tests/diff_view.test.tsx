// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiffFile } from "../src/shared/diff/parse.ts";
import { DiffView } from "../src/web/diff/DiffView.tsx";

afterEach(cleanup);

function file(path: string, lines: number, changes: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    old_path: path,
    status: "changed",
    additions: lines,
    deletions: 0,
    hunks: [{ header: `@@ -0,0 +1,${lines} @@`, lines: Array.from({ length: lines }, (_, index) => ({ kind: "added" as const, text: `${path} line ${index + 1}`, old_number: null, new_number: index + 1 })) }],
    ...changes,
  };
}

describe("a diff view", () => {
  it("lists the files with their counts, folds long ones and opens one from the list", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<DiffView files={[file("short.ts", 2), file("long.ts", 5), file("moved.ts", 0, { old_path: "old.ts", status: "renamed", hunks: [] })]} fold_lines={3} truncated />);

    expect(screen.getByText(/3 files changed/)).toBeTruthy();
    expect(screen.getByText("short.ts line 1")).toBeTruthy();
    expect(screen.queryByText("long.ts line 1")).toBeNull();
    expect(screen.getByText("5 lines, folded")).toBeTruthy();
    expect(screen.getAllByText("old.ts → moved.ts").length).toBe(2);
    expect(screen.getByText(/left out/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "long.ts" })[0]!);
    expect(screen.getByText("long.ts line 5")).toBeTruthy();
    expect(scrolled).toHaveBeenCalled();
    expect(screen.getByText(/No lines to show/)).toBeTruthy();
  });

  it("says so when nothing changed", () => {
    render(<DiffView files={[]} empty_text="The branch has no changes yet." />);
    expect(screen.getByText("The branch has no changes yet.")).toBeTruthy();
  });
});
