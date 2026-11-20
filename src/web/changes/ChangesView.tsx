// What a run or the whole item changed, to read and confirm: the changed files as a folder tree on the left, the picked
// file's diff on the right, side by side or in one column (always one column on a narrow window), a Reviewed tick per
// file that clears once the file changes again, and Revert File, which puts a file back as it was after a confirm.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Segmented } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";

import type { Run } from "../../shared/runs/model.ts";
import type { ChangedFile, ChangeScope } from "../../shared/runs/runner.ts";
import { calls, data_watch, page, succeeds } from "../api.ts";
import { Counts, FileDiff, status_words, type DiffLayout } from "../diff/DiffView.tsx";
import { FileTree } from "../diff/FileTree.tsx";

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
  const narrow = use_narrow();
  const layout = narrow ? "unified" : chosen_layout;
  const changes = use_resource(async () => runner!.get_changes(item_id, scope, run_id), [runner, item_id, scope, run_id, refresh_key]);
  if (!runner) return <p className="muted">The changes are read on the desktop app, whose background process holds the item's worktree.</p>;
  const busy = runs.some((run) => run.state === "running");

  return (
    <div className="changes-view">
      <div className="spread-row">
        <Segmented<ChangeScope> label="Changes since" choices={[...(runs.length ? [{ value: "run" as const, label: "This run" }] : []), { value: "item", label: "Whole item" }]} value={scope} on_change={set_scope} />
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
          const picked = found.files.find((file) => file.path === selected) ?? found.files[0];
          if (!picked) return <p className="muted">{scope === "run" ? "The run has changed nothing yet." : "The branch has no changes yet."}</p>;
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
              </p>
              <div className="changes-panes">
                <FileTree files={found.files} selected={picked.path} on_select={set_selected} extra={(file) => is_reviewed(found.files.find((each) => each.path === file.path)!) && <Badge tone="good" title="Reviewed">✓</Badge>} />
                <FilePane item_id={item_id} scope={scope} run_id={found.run_id} file={picked} reviewed={is_reviewed(picked)} layout={layout} busy={busy} />
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
