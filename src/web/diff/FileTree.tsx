// The changed files as a folder tree on X-Libs' Tree: folders first and folding, each file with a letter for how it
// changed and its added and removed lines, walked with the arrow keys and picked with Enter or a click, narrowed by a
// filter box that keeps the folders of the files it matches.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type ReactNode } from "react";
import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { SearchBox } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Tree, type TreeItem } from "@x-tech-laboratories/x-libs/web/react/tree";

import type { DiffFileStatus } from "../../shared/diff/parse.ts";
import { Counts, status_words } from "./DiffView.tsx";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface TreeFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
}

interface Row extends TreeItem {
  name: string;
  file: TreeFile | null;
}

const folder_id = (path: string) => `folder:${path}`;

// The files and the folders that hold them as tree rows, folders before files and each by name.
export function tree_rows(files: TreeFile[]): Row[] {
  const rows = new Map<string, Row>();
  const add_folder = (path: string): string | null => {
    if (!path) return null;
    const id = folder_id(path);
    if (!rows.has(id)) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      rows.set(id, { id, parent_id: add_folder(parent), position: 0, name: path.slice(path.lastIndexOf("/") + 1), file: null });
    }
    return id;
  };
  for (const file of files) {
    const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    rows.set(`file:${file.path}`, { id: `file:${file.path}`, parent_id: add_folder(folder), position: 0, name: file.path.slice(file.path.lastIndexOf("/") + 1), file });
  }
  const sorted = [...rows.values()].sort((first, second) => Number(first.file !== null) - Number(second.file !== null) || first.name.localeCompare(second.name));
  return sorted.map((row, index) => ({ ...row, position: index }));
}

// ── View ─────────────────────────────────────────────────────────────────────

interface FileTreeProps {
  files: TreeFile[];
  selected: string | null;
  on_select: (path: string) => void;
  // Anything to show beside a file's counts, such as a reviewed mark.
  extra?: (file: TreeFile) => ReactNode;
}

export function FileTree({ files, selected, on_select, extra }: FileTreeProps) {
  const [filter, set_filter] = useState("");
  const [collapsed, set_collapsed] = useState<Set<string>>(new Set());
  const needle = filter.trim().toLowerCase();
  const shown = needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
  return (
    <div className="file-tree">
      <SearchBox label="Filter files" value={filter} on_input={set_filter} />
      {shown.length === 0 ? (
        <p className="muted small">{files.length ? "No file matches." : "No files changed."}</p>
      ) : (
        <Tree<Row>
          items={tree_rows(shown)}
          label="Changed files"
          collapsed={collapsed}
          on_collapsed_change={set_collapsed}
          selected_id={selected ? `file:${selected}` : null}
          on_select={(row) => (row.file ? on_select(row.file.path) : set_collapsed((current) => (current.has(row.id) ? new Set([...current].filter((id) => id !== row.id)) : new Set([...current, row.id]))))}
          name_of={(row) => row.name}
          render_item={(row) => (row.file ? <span className="tree-name">{row.name}</span> : <span>{row.name}/</span>)}
          render_extra={(row) =>
            row.file && (
              <>
                {extra?.(row.file)}
                <Counts additions={row.file.additions} deletions={row.file.deletions} />
                <Badge tone={status_words[row.file.status][2]} title={status_words[row.file.status][0]}>
                  {status_words[row.file.status][1]}
                </Badge>
              </>
            )
          }
        />
      )}
    </div>
  );
}
