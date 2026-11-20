// One run's report in a dialog over the board: how it went, its error, its questions with the answer form while it
// waits, its gates and its report, with a link to the item page at that run.

// ── Imports ──────────────────────────────────────────────────────────────────

import { StateBadge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { format_count } from "@x-tech-laboratories/x-libs/web/format";
import { Facts } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Markdown } from "@x-tech-laboratories/x-libs/web/react/markdown";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";

import { gate_marks } from "../../shared/runs/model.ts";
import { use_data } from "../api.ts";
import { Answers } from "../items/ItemView.tsx";
import { run_state_labels } from "../items/words.ts";
import { GateChips } from "./ItemCard.tsx";

// ── Dialog ───────────────────────────────────────────────────────────────────

interface RunDialogProps {
  run_id: string;
  // The stage's name as the page shows it.
  stage_label: string;
  item_title: string;
  on_close: () => void;
}

export function RunDialog({ run_id, stage_label, item_title, on_close }: RunDialogProps) {
  const run = use_data((api) => api.get_run(run_id), [run_id]);
  return (
    <Dialog
      title={`${stage_label} Run`}
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
      <Loaded resource={run}>
        {(found) => (
          <div className="run-dialog">
            <Facts
              rows={[
                ["State", <StateBadge key="state" labels={run_state_labels} state={found.state} />],
                ["Started", <Age key="started" epoch={Date.parse(found.started_at) / 1000} />],
                ["Model", found.model || "Default"],
                ["Cost", `$${found.cost_usd.toFixed(2)}`],
                found.input_tokens + found.output_tokens > 0 ? ["Tokens", `${format_count(found.input_tokens)} read, ${format_count(found.output_tokens)} written`] : null,
              ]}
            />
            {found.error && (
              <p className="danger" role="alert">
                {found.error}
              </p>
            )}
            {found.state === "waiting" && <Answers run={found} />}
            <GateChips gates={gate_marks(found.gates, found.overrides)} />
            {found.report ? <Markdown text={found.report} /> : <p className="muted">No report yet.</p>}
          </div>
        )}
      </Loaded>
    </Dialog>
  );
}
