// What a run or the whole item changed, to read and confirm: the changed files as a folder tree on the left, or every
// file in the worktree with the changed ones marked, the picked file's diff on the right, side by side or in one column
// (always one column on a narrow window), or an unchanged file's text read-only, a Reviewed tick per file that clears
// once the file changes again, and Revert File, which puts a file back as it was after a confirm.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Segmented } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";

import type { Run } from "../../shared/runs/model.ts";
import type { ChangedFile, ChangeScope } from "../../shared/runs/runner.ts";
import { calls, data_watch, page, succeeds } from "../api.ts";
import { Counts, FileContent, FileDiff, status_words, type DiffLayout } from "../diff/DiffView.tsx";
import { FileTree, type TreeFile } from "../diff/FileTree.tsx";

// ── Window width ─────────────────────────────────────────────────────────────

const narrow_query = "(max-width: 900px)";

// Whether the window is too narrow for two columns of code side by side.
function use_narrow(): boolean {
  const query = typeof window.matchMedia === "function" ? window.matchMedia(narrow_query) : null;
  const [narrow, set_narrow] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const on_change = () => set_narrow(query.matches);
    query.addEventListener("change", on_change);
    return () => query.removeEventListener("change", on_change);
  }, [query]);
  return narrow;
}

// ── File ─────────────────────────────────────────────────────────────────────

interface FilePaneProps {
  item_id: string;
  scope: ChangeScope;
  run_id: string;
  file: ChangedFile;
  reviewed: boolean;
  layout: DiffLayout;
  // Whether a run on the item is under way, which a revert waits for.
  busy: boolean;
}

function FilePane({ item_id, scope, run_id, file, reviewed, layout, busy }: FilePaneProps) {
  const { runner } = page();
  const change = use_resource(async () => runner!.get_file_change(item_id, scope, run_id, file.path), [item_id, scope, run_id, file.path, file.fingerprint]);

  function revert(): void {
    confirm_dialog({
      title: `Revert ${file.path}?`,
      message:
        file.status === "added"
          ? `The file is removed, since it did not exist when ${scope === "run" ? "the run" : "the item's work"} started. The run and the status sheet note that you reverted it.`
          : `The file goes back to how it was when ${scope === "run" ? "the run" : "the item's work"} started, losing every change made to it since. The run and the status sheet note that you reverted it.`,
      confirm_label: "Revert File",
      danger: true,
      run: async () => void ((await succeeds(() => runner!.revert_file(item_id, scope, run_id, file.path), `${file.path} reverted.`)) && data_watch.bump()),
    });
  }

  return (
    <div className="changes-file">
      <div className="spread-row">
        <span className="inline-row">
          <code className="diff-path">{file.status === "renamed" ? `${file.old_path} → ${file.path}` : file.path}</code>
          <Badge tone={status_words[file.status][2]}>{status_words[file.status][0]}</Badge>
          <Counts additions={file.additions} deletions={file.deletions} />
        </span>
        <span className="inline-row">
          {run_id && (
            <label className="check">
              <input type="checkbox" checked={reviewed} onChange={(event) => void succeeds(() => calls().set_file_reviewed(run_id, file.path, event.currentTarget.checked ? file.fingerprint : ""))} /> Reviewed
            </label>
          )}
          <button type="button" className="danger" disabled={busy} title={busy ? "A run on this item is under way" : undefined} onClick={revert}>
            Revert File…
          </button>
        </span>
      </div>
      <Loaded resource={change}>
        {(found) => (
          <>
            {found.file ? <FileDiff key={`${file.path} ${layout}`} file={found.file} layout={layout} /> : <p className="muted small">{file.binary ? "A binary file; its lines are not shown." : "No lines to show."}</p>}
            {found.truncated && <p className="muted small">The file is too long to show whole; its later lines are left out.</p>}
          </>
        )}
      </Loaded>
    </div>
  );
}

// An unchanged file's text, read-only.
function PlainPane({ item_id, path, refresh_key }: { item_id: string; path: string; refresh_key: string }) {
  const { runner } = page();
  const file = use_resource(async () => runner!.get_file(item_id, path), [item_id, path, refresh_key]);
  return (
    <div className="changes-file">
      <span className="inline-row">
        <code className="diff-path">{path}</code>
        <span className="muted small">Unchanged</span>
      </span>
      <Loaded resource={file}>
        {(found) =>
          found.text !== null ? (
            <FileContent path={path} text={found.text} />
          ) : (
            <p className="muted small">{found.reason === "binary" ? "A binary file; its contents are not shown." : "The file is over a megabyte, too large to show."}</p>
          )
        }
      </Loaded>
    </div>
  );
}

type FileSet = "changed" | "all";

// Every worktree file as the tree takes it, the changed ones carrying how they changed.
function all_tree_files(paths: string[], changed: ChangedFile[]): TreeFile[] {
  const by_path = new Map(changed.map((file) => [file.path, file]));
  const removed = changed.filter((file) => file.status === "removed");
  return [...paths.map((path) => by_path.get(path) ?? { path }), ...removed].sort((first, second) => first.path.localeCompare(second.path));
}

// ── View ─────────────────────────────────────────────────────────────────────

interface ChangesViewProps {
  item_id: string;
  // The item's runs, newest first, whose reviewed marks the view shows.
  runs: Run[];
  // The run "This run" means; the item's latest when left out.
  run_id?: string;
  initial_scope?: ChangeScope;
  // Changes whenever the worktree may have changed, such as when a run edits a file, so the view reads it again.
  refresh_key: string;
}

export function ChangesView({ item_id, runs, run_id = "", initial_scope = "run", refresh_key }: ChangesViewProps) {
  const { runner } = page();
  const [scope, set_scope] = useState<ChangeScope>(runs.length ? initial_scope : "item");
  const [chosen_layout, set_layout] = useState<DiffLayout>("split");
  const [selected, set_selected] = useState<string | null>(null);
  const [file_set, set_file_set] = useState<FileSet>("changed");
  const narrow = use_narrow();
  const layout = narrow ? "unified" : chosen_layout;
  const changes = use_resource(async () => runner!.get_changes(item_id, scope, run_id), [runner, item_id, scope, run_id, refresh_key]);
  const all_files = use_resource(async () => (file_set === "all" ? runner!.list_files(item_id) : null), [runner, item_id, file_set, refresh_key]);
  if (!runner) return <p className="muted">The changes are read on the desktop app, whose background process holds the item's worktree.</p>;
  const busy = runs.some((run) => run.state === "running");

  return (
    <div className="changes-view">
      <div className="spread-row">
        <span className="inline-row">
          <Segmented<ChangeScope> label="Changes since" choices={[...(runs.length ? [{ value: "run" as const, label: "This run" }] : []), { value: "item", label: "Whole item" }]} value={scope} on_change={set_scope} />
          <Segmented<FileSet>
            label="Files"
            choices={[
              { value: "changed", label: "Changed" },
              { value: "all", label: "All files" },
            ]}
            value={file_set}
            on_change={set_file_set}
          />
        </span>
        {!narrow && (
          <Segmented<DiffLayout>
            label="Layout"
            choices={[
              { value: "split", label: "Side by side" },
              { value: "unified", label: "Unified" },
            ]}
            value={chosen_layout}
            on_change={set_layout}
          />
        )}
      </div>
      <Loaded resource={changes}>
        {(found) => {
          if (found.problem) return <p className="muted">{found.problem}</p>;
          const reviewed = runs.find((run) => run.id === found.run_id)?.reviewed ?? {};
          const is_reviewed = (file: ChangedFile) => reviewed[file.path] === file.fingerprint;
          const totals = found.files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
          const showing_all = file_set === "all" && all_files.data;
          const tree_files: TreeFile[] = showing_all ? all_tree_files(all_files.data!.paths, found.files) : found.files;
          const picked = found.files.find((file) => file.path === selected) ?? (showing_all && selected && tree_files.some((file) => file.path === selected) ? null : found.files[0]);
          const plain_path = picked === null ? selected : null;
          if (!picked && !plain_path && !showing_all) return <p className="muted">{scope === "run" ? "The run has changed nothing yet." : "The branch has no changes yet."}</p>;
          const changed_folders = new Set(found.files.flatMap((file) => file.path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
          return (
            <>
              <p className="small">
                {found.files.length} file{found.files.length === 1 ? "" : "s"} changed <Counts {...totals} />
                {found.run_id && (
                  <span className="muted">
                    {" "}
                    · {found.files.filter(is_reviewed).length} of {found.files.length} reviewed
                  </span>
                )}
                {showing_all && all_files.data!.truncated && <span className="muted"> · only the first {all_files.data!.paths.length.toLocaleString()} files are listed</span>}
              </p>
              <div className="changes-panes">
                <FileTree
                  key={showing_all ? "all" : "changed"}
                  files={tree_files}
                  label={showing_all ? "All files" : "Changed files"}
                  selected={picked?.path ?? plain_path}
                  on_select={set_selected}
                  folded={showing_all ? (folder) => !changed_folders.has(folder) : undefined}
                  extra={(file) => file.status && is_reviewed(file as ChangedFile) && <Badge tone="good" title="Reviewed">✓</Badge>}
                />
                {picked ? (
                  <FilePane item_id={item_id} scope={scope} run_id={found.run_id} file={picked} reviewed={is_reviewed(picked)} layout={layout} busy={busy} />
                ) : plain_path ? (
                  <PlainPane item_id={item_id} path={plain_path} refresh_key={refresh_key} />
                ) : (
                  <p className="muted">Pick a file to read it.</p>
                )}
              </div>
            </>
          );
        }}
      </Loaded>
    </div>
  );
}

// What changes as a run edits the worktree: each run's state and end, and the running run's finished tool calls.
export function changes_key(runs: Run[]): string {
  return runs.map((run) => `${run.id}:${run.state}:${run.end_commit}:${run.reverts.length}:${run.state === "running" ? (run.transcript.match(/"result":/g)?.length ?? 0) : ""}`).join(",");
}
