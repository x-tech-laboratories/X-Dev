// One run's live view in a dialog over the board, with a link to its item page at that run.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import { use_data } from "../api.ts";
import { LiveRun } from "./LiveRun.tsx";

// ── Dialog ───────────────────────────────────────────────────────────────────

interface TranscriptDialogProps {
  run_id: string;
  stage_label: string;
  item_title: string;
  // Whether the run is its stage's latest, which Retry is offered on.
  is_latest: boolean;
  on_close: () => void;
}

export function TranscriptDialog({ run_id, stage_label, item_title, is_latest, on_close }: TranscriptDialogProps) {
  const run = use_data((api) => api.get_run(run_id), [run_id]);
  return (
    <Dialog
      title={`${stage_label} Transcript`}
      subtitle={item_title}
      wide
      on_close={on_close}
      buttons={
        <>
          {run.data && (
            <a className="button" href={`#/items/${encodeURIComponent(run.data.item_id)}/${encodeURIComponent(run_id)}`} onClick={on_close}>
              Open the Item at This Run
            </a>
          )}
          <button type="button" onClick={on_close}>
            Close
          </button>
        </>
      }
    >
      <Loaded resource={run}>{(found) => <LiveRun run={found} stage_label={stage_label} is_latest={is_latest} />}</Loaded>
    </Dialog>
  );
}
