// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parse_unified_diff } from "../src/shared/diff/parse.ts";
import { FileDiff } from "../src/web/diff/DiffView.tsx";
import { FileTree, tree_rows } from "../src/web/diff/FileTree.tsx";

afterEach(cleanup);

const lines = (count: number, from = 1) => Array.from({ length: count }, (_, index) => ` same ${from + index}`);
const file = parse_unified_diff(["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,12 +1,12 @@", ...lines(10), "-const lanes = 1;", "+const lanes = 2;", " end", ""].join("\n"))[0]!;

describe("a file's diff", () => {
  it("shows old and new side by side, the changed word tinted again, and opens a folded stretch", () => {
    render(<FileDiff file={file} layout="split" />);
    const table = screen.getByRole("table", { name: /old on the left and new on the right/ });

    expect(within(table).getByText("1").className).toContain("tone-fill-bad");
    expect(within(table).getByText("2").className).toContain("tone-fill-good");
    expect(within(table).getAllByLabelText("removed")[0]!.className).toContain("tone-fill-bad");
    expect(within(table).queryByText("same 1")).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Show 7 more unchanged lines" }));
    expect(within(table).getAllByText("same 1")).toHaveLength(2);
  });

  it("shows one column with old and new numbers when unified, and says when there are no lines", () => {
    render(<FileDiff file={file} layout="unified" />);
    const table = screen.getByRole("table", { name: "Changes to a.ts" });
    expect(within(table).getByLabelText("removed").textContent).toBe("−");
    expect(within(table).getByLabelText("added").closest("tr")!.className).toBe("tone-fill-good");
    cleanup();

    render(<FileDiff file={{ ...file, hunks: [] }} layout="split" />);
    expect(screen.getByText(/No lines to show/)).toBeTruthy();
  });
});

describe("the changed files as a tree", () => {
  const files = [
    { path: "src/web/board.tsx", status: "changed" as const, additions: 3, deletions: 1 },
    { path: "src/web/lane.tsx", status: "added" as const, additions: 9, deletions: 0 },
    { path: "README.md", status: "removed" as const, additions: 0, deletions: 4 },
  ];

  it("puts folders before files, each folder once", () => {
    expect(tree_rows(files).map((row) => [row.id, row.parent_id])).toEqual([
      ["folder:src", null],
      ["folder:src/web", "folder:src"],
      ["file:src/web/board.tsx", "folder:src/web"],
      ["file:src/web/lane.tsx", "folder:src/web"],
      ["file:README.md", null],
    ]);
  });

  it("shows each file's status and counts, picks a file by click or keys, folds folders and filters", async () => {
    const on_select = vi.fn();
    render(<FileTree files={files} selected="src/web/board.tsx" on_select={on_select} extra={(each) => each.path === "README.md" && <span>seen</span>} />);
    const tree = screen.getByRole("tree", { name: "Changed files" });

    expect(within(tree).getByTitle("Modified").textContent).toBe("M");
    expect(within(tree).getByTitle("Deleted").textContent).toBe("D");
    expect(within(tree).getByText("seen")).toBeTruthy();
    fireEvent.click(within(tree).getByText("lane.tsx"));
    expect(on_select).toHaveBeenCalledWith("src/web/lane.tsx");
    fireEvent.keyDown(within(tree).getByText("README.md").closest("[role=treeitem]")!, { key: "Enter" });
    expect(on_select).toHaveBeenCalledWith("README.md");

    fireEvent.click(within(tree).getByText("web/"));
    expect(within(tree).queryByText("lane.tsx")).toBeNull();
    fireEvent.click(within(tree).getByText("web/"));
    expect(within(tree).getByText("lane.tsx")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), { target: { value: "lane" } });
    await waitFor(() => expect(screen.queryByText("README.md")).toBeNull());
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), { target: { value: "nothing" } });
    expect(await screen.findByText("No file matches.")).toBeTruthy();
  });
});
