// The item page's Changes section: the item branch's diff against the commit its work started from, read again after
// each run moves on, on the desktop, whose daemon holds the worktree.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";

import type { Item } from "../../shared/items/model.ts";
import type { Run } from "../../shared/runs/model.ts";
import { page } from "../api.ts";
import { DiffView } from "../diff/DiffView.tsx";

// ── Section ──────────────────────────────────────────────────────────────────

export function BranchChanges({ item, runs }: { item: Item; runs: Run[] }) {
  const { runner } = page();
  // Read again whenever a run starts, ends or changes state, not on every line it streams.
  const runs_key = runs.map((run) => `${run.id}:${run.state}:${run.end_commit}`).join(",");
  const diff = use_resource(async () => (runner ? await runner.get_item_diff(item.id) : null), [runner, item.id, item.branch, runs_key]);

  return (
    <Section title="Changes">
      {!runner ? (
        <p className="muted">The changes are read on the desktop app, whose background process holds the item's worktree.</p>
      ) : (
        <Loaded resource={diff}>
          {(found) =>
            !found ? null : found.problem ? (
              <p className="muted">{found.problem}</p>
            ) : (
              <DiffView key={`${found.base} ${runs_key}`} files={found.files} truncated={found.truncated} empty_text="The branch has no changes yet." />
            )
          }
        </Loaded>
      )}
    </Section>
  );
}
