// A small diff of one edit: the lines a change takes out and puts in, worked out with jsdiff from the text before and
// after, unchanged lines kept for context, and a long change cut short.

// ── Imports ──────────────────────────────────────────────────────────────────

import { diffLines } from "diff";

// ── Lines ────────────────────────────────────────────────────────────────────

type EditLineKind = "added" | "removed" | "context";

interface EditLine {
  kind: EditLineKind;
  text: string;
}

// The most lines one edit shows.
const shown_lines = 120;

// The before and after as lines marked added, removed or kept.
export function edit_lines(before: string, after: string): EditLine[] {
  return diffLines(before, after).flatMap((part) => {
    const kind: EditLineKind = part.added ? "added" : part.removed ? "removed" : "context";
    return part.value.replace(/\n$/, "").split("\n").map((text) => ({ kind, text }));
  });
}

const line_classes: Record<EditLineKind, string> = { added: "tone-fill-good", removed: "tone-fill-bad", context: "" };

const line_marks: Record<EditLineKind, string> = { added: "+", removed: "−", context: " " };

// ── View ─────────────────────────────────────────────────────────────────────

export function EditDiff({ path, before, after }: { path: string; before: string; after: string }) {
  const lines = edit_lines(before, after);
  const kept = lines.slice(0, shown_lines);
  return (
    <div className="edit-diff">
      {path && <code className="small muted">{path}</code>}
      <div className="diff-scroll">
        <table className="diff-lines" aria-label={path ? `Change to ${path}` : "Change"}>
          <tbody>
            {kept.map((line, index) => (
              <tr key={index} className={line_classes[line.kind]}>
                <td className="diff-mark" aria-label={line.kind === "context" ? undefined : line.kind}>
                  {line_marks[line.kind]}
                </td>
                <td>
                  <code>{line.text}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length > kept.length && <p className="muted small">{lines.length - kept.length} more lines left out.</p>}
    </div>
  );
}
