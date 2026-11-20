// One file's change: side by side with the old lines on the left and the new on the right, or in one column, each line
// numbered, removed and added lines tinted and the words that changed within them tinted again, and long unchanged
// stretches folded behind a "show more" row.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Fragment, useState } from "react";
import type { Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { cx } from "@x-tech-laboratories/x-libs/web/dom";

import type { DiffFile, DiffFileStatus } from "../../shared/diff/parse.ts";
import { fold_rows, split_rows, unified_rows, type Cell, type Fold, type WordPart } from "../../shared/diff/rows.ts";

// ── Words ────────────────────────────────────────────────────────────────────

export const status_words: Record<DiffFileStatus, [label: string, letter: string, tone: Tone]> = {
  added: ["Added", "A", "good"],
  removed: ["Deleted", "D", "bad"],
  renamed: ["Renamed", "R", "info"],
  changed: ["Modified", "M", "warn"],
};

export type DiffLayout = "split" | "unified";

// ── Pieces ───────────────────────────────────────────────────────────────────

export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-counts small">
      <span className="tone-good">+{additions}</span> <span className="tone-bad">−{deletions}</span>
    </span>
  );
}

// A line's text with its changed words tinted in the tone of its side.
function Words({ parts, tone }: { parts: WordPart[]; tone: "good" | "bad" | null }) {
  return (
    <code>
      {parts.map((part, index) =>
        part.changed && tone ? (
          <span key={index} className={`tone-fill-${tone} diff-word`}>
            {part.text}
          </span>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </code>
  );
}

function FoldRow({ fold, columns, on_open }: { fold: Fold; columns: number; on_open: (start: number) => void }) {
  return (
    <tr className="diff-fold muted">
      <td colSpan={columns}>
        <button type="button" className="link" onClick={() => on_open(fold.start)}>
          Show {fold.count} more unchanged lines
        </button>
      </td>
    </tr>
  );
}

function HunkRow({ header, columns }: { header: string; columns: number }) {
  return (
    <tr className="diff-hunk muted">
      <td colSpan={columns}>
        <code>{header}</code>
      </td>
    </tr>
  );
}

function Side({ cell, tone }: { cell: Cell | null; tone: "good" | "bad" | null }) {
  if (!cell) {
    return (
      <>
        <td className="diff-number tone-fill-none" />
        <td className="diff-text tone-fill-none" />
      </>
    );
  }
  const fill = tone ? `tone-fill-${tone}` : "";
  return (
    <>
      <td className={cx("diff-number muted", fill)}>{cell.number}</td>
      <td className={cx("diff-text", fill)} aria-label={tone === "bad" ? "removed" : tone === "good" ? "added" : undefined}>
        <Words parts={cell.parts} tone={tone} />
      </td>
    </>
  );
}

// ── View ─────────────────────────────────────────────────────────────────────

interface FileDiffProps {
  file: DiffFile;
  layout: DiffLayout;
}

export function FileDiff({ file, layout }: FileDiffProps) {
  const [opened, set_opened] = useState<ReadonlySet<number>>(new Set());
  const open = (start: number) => set_opened((current) => new Set([...current, start]));
  if (file.hunks.length === 0) return <p className="muted small">No lines to show: a binary file, a bare rename or a change of mode.</p>;

  if (layout === "unified") {
    const rows = fold_rows(unified_rows(file), opened);
    return (
      <div className="diff-scroll">
        <table className="diff-lines diff-unified" aria-label={`Changes to ${file.path}`}>
          <tbody>
            {rows.map((row, index) => {
              if (row.kind === "fold") return <FoldRow key={`fold-${row.start}`} fold={row} columns={4} on_open={open} />;
              if (row.kind === "hunk") return <HunkRow key={index} header={row.header} columns={4} />;
              const tone = row.kind === "added" ? "good" : row.kind === "removed" ? "bad" : null;
              return (
                <tr key={index} className={tone ? `tone-fill-${tone}` : ""}>
                  <td className="diff-number muted">{row.old_number ?? ""}</td>
                  <td className="diff-number muted">{row.new_number ?? ""}</td>
                  <td className="diff-mark" aria-label={tone ? row.kind : undefined}>
                    {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
                  </td>
                  <td className="diff-text">
                    <Words parts={row.parts} tone={tone} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const rows = fold_rows(split_rows(file), opened);
  return (
    <div className="diff-scroll">
      <table className="diff-lines diff-split" aria-label={`Changes to ${file.path}, old on the left and new on the right`}>
        <colgroup>
          <col className="diff-number-column" />
          <col />
          <col className="diff-number-column" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row, index) => {
            if (row.kind === "fold") return <FoldRow key={`fold-${row.start}`} fold={row} columns={4} on_open={open} />;
            if (row.kind === "hunk") return <HunkRow key={index} header={row.header} columns={4} />;
            const changed = row.kind === "change";
            return (
              <tr key={index}>
                <Side cell={row.left} tone={changed ? "bad" : null} />
                <Side cell={row.right} tone={changed ? "good" : null} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Plain file ───────────────────────────────────────────────────────────────

// A file's text read-only, each line numbered, with no diff columns.
export function FileContent({ path, text }: { path: string; text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="diff-scroll">
      <table className="diff-lines diff-plain" aria-label={`Contents of ${path}`}>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td className="diff-number muted">{index + 1}</td>
              <td className="diff-text">
                <code>{line}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

