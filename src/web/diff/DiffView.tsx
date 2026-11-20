// A change shown file by file: a list of the changed files with their added and removed line counts, then each file's
// hunks with old and new line numbers, added and removed lines tinted, and long files folded until opened.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Fragment, useState } from "react";
import { Badge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";

import { diff_totals, type DiffFile, type DiffFileStatus, type DiffLineKind } from "../../shared/diff/parse.ts";

// ── Words ────────────────────────────────────────────────────────────────────

const status_badges: Record<DiffFileStatus, [string, Tone]> = {
  added: ["Added", "good"],
  removed: ["Removed", "bad"],
  renamed: ["Renamed", "info"],
  changed: ["Changed", "none"],
};

const line_classes: Record<DiffLineKind, string> = { added: "tone-fill-good", removed: "tone-fill-bad", context: "" };

const line_marks: Record<DiffLineKind, string> = { added: "+", removed: "−", context: " " };

// Lines past which a file starts folded.
export const default_fold_lines = 300;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function line_count(file: DiffFile): number {
  return file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-counts small">
      <span className="tone-good">+{additions}</span> <span className="tone-bad">−{deletions}</span>
    </span>
  );
}

function FileName({ file }: { file: DiffFile }) {
  return <code className="diff-path">{file.status === "renamed" ? `${file.old_path} → ${file.path}` : file.path}</code>;
}

function FileLines({ file }: { file: DiffFile }) {
  if (file.hunks.length === 0) return <p className="muted small">No lines to show: a binary file, a bare rename or a change of mode.</p>;
  return (
    <div className="diff-scroll">
      <table className="diff-lines">
        <tbody>
          {file.hunks.map((hunk, hunk_index) => (
            <Fragment key={hunk_index}>
              <tr className="diff-hunk muted">
                <td colSpan={4}>
                  <code>{hunk.header}</code>
                </td>
              </tr>
              {hunk.lines.map((line, line_index) => (
                <tr key={line_index} className={line_classes[line.kind]}>
                  <td className="diff-number muted">{line.old_number ?? ""}</td>
                  <td className="diff-number muted">{line.new_number ?? ""}</td>
                  <td className="diff-mark" aria-label={line.kind === "context" ? undefined : line.kind}>
                    {line_marks[line.kind]}
                  </td>
                  <td>
                    <code>{line.text}</code>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── View ─────────────────────────────────────────────────────────────────────

interface DiffViewProps {
  files: DiffFile[];
  // Files with more lines than this start folded.
  fold_lines?: number;
  // Whether later files were left out because the change was too long to show.
  truncated?: boolean;
  // Words for the reader when nothing changed.
  empty_text?: string;
}

export function DiffView({ files, fold_lines = default_fold_lines, truncated = false, empty_text = "Nothing has changed." }: DiffViewProps) {
  const [open, set_open] = useState<Set<number>>(() => new Set(files.flatMap((file, index) => (line_count(file) <= fold_lines ? [index] : []))));
  if (files.length === 0) return <p className="muted">{empty_text}</p>;
  const totals = diff_totals(files);

  function toggle(index: number, is_open: boolean): void {
    set_open((current) => {
      const next = new Set(current);
      if (is_open) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function show(index: number): void {
    toggle(index, true);
    document.getElementById(`diff-file-${index}`)?.scrollIntoView({ block: "start" });
  }

  return (
    <div className="diff-view">
      <p className="diff-summary">
        {plural(files.length, "file")} changed <Counts {...totals} />
      </p>
      <ul className="diff-files">
        {files.map((file, index) => (
          <li key={file.path}>
            <button type="button" className="link" onClick={() => show(index)}>
              <FileName file={file} />
            </button>{" "}
            <Counts additions={file.additions} deletions={file.deletions} />
          </li>
        ))}
      </ul>
      {files.map((file, index) => (
        <details key={file.path} id={`diff-file-${index}`} className="form-group diff-file" open={open.has(index)} onToggle={(event) => toggle(index, event.currentTarget.open)}>
          <summary>
            <FileName file={file} /> <Badge tone={status_badges[file.status][1]}>{status_badges[file.status][0]}</Badge> <Counts additions={file.additions} deletions={file.deletions} />
            {!open.has(index) && line_count(file) > fold_lines && <span className="muted small">{plural(line_count(file), "line")}, folded</span>}
          </summary>
          {open.has(index) && <FileLines file={file} />}
        </details>
      ))}
      {truncated && <p className="muted small">The change is too long to show whole; the files after these are left out.</p>}
    </div>
  );
}
