// Retry for a run that failed or was stopped: the stage runs again on the worktree as the run left it, told how that
// attempt ended; its menu retries on another model, or from clean, which discards the run first after a confirm.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { confirm_dialog, Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { MenuButton } from "@x-tech-laboratories/x-libs/web/react/menu_button";
import { ComboField } from "@x-tech-laboratories/x-libs/web/react/suggestions";

import type { RetryOptions } from "../../shared/runs/runner.ts";
import type { RunMode } from "../../shared/runs/modes.ts";
import { model_suggestions } from "../../shared/stages/model.ts";
import { data_watch, page, succeeds } from "../api.ts";
import { mode_option, ModePicker } from "./ModePicker.tsx";

// ── Retrying ─────────────────────────────────────────────────────────────────

async function retry(run_id: string, options: RetryOptions): Promise<boolean> {
  const ok = await succeeds(() => page().runner!.retry_run(run_id, options), options.clean ? "Discarded and started again." : "Started again.");
  if (ok) data_watch.bump();
  return ok;
}

// Asks before discarding the run, since its worktree goes back to where it started.
export function confirm_retry_from_clean(run_id: string, stage_label: string, options: Omit<RetryOptions, "clean"> = {}): void {
  confirm_dialog({
    title: `Retry ${stage_label} from clean?`,
    message: "The failed run is discarded first: the worktree goes back to the commit it started from and the status sheet to how it was. Then the stage runs afresh, not told how the last attempt went.",
    confirm_label: "Discard and Retry",
    danger: true,
    run: async () => void (await retry(run_id, { clean: true, ...options })),
  });
}

function ModelDialog({ run_id, stage_label, stage_mode, on_close }: { run_id: string; stage_label: string; stage_mode: RunMode | ""; on_close: () => void }) {
  const [model, set_model] = useState("");
  const [mode, set_mode] = useState<RunMode | "">("");
  return (
    <Dialog
      title={`Retry ${stage_label} on Another Model`}
      on_close={on_close}
      buttons={
        <>
          <button type="button" onClick={on_close}>
            Cancel
          </button>
          <button type="button" className="accent solid" onClick={() => void retry(run_id, { ...(model.trim() ? { model: model.trim() } : {}), ...mode_option(mode) }).then((ok) => ok && on_close())}>
            Retry
          </button>
        </>
      }
    >
      <FormRow label="Model for this run" id="retry-model">
        <ComboField label="Model for this run" placeholder="The stage's model" value={model} options={model_suggestions} on_change={set_model} />
      </FormRow>
      <FormRow label="Permission mode" id="retry-mode">
        <ModePicker stage_mode={stage_mode} value={mode} on_change={set_mode} />
      </FormRow>
    </Dialog>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────

export function RetryButton({ run, stage_label, stage_mode = "" }: { run: { id: string }; stage_label: string; stage_mode?: RunMode | "" }) {
  const [picking_model, set_picking_model] = useState(false);
  return (
    <span className="inline-row">
      <button type="button" className="accent solid" title="Run the stage again on the worktree as the run left it, telling it what went wrong" onClick={() => void retry(run.id, {})}>
        Retry
      </button>
      <MenuButton
        label={`More ways to retry ${stage_label}`}
        items={[
          { label: "Retry on Another Model…", run: () => set_picking_model(true) },
          { label: "Retry from Clean…", danger: true, run: () => confirm_retry_from_clean(run.id, stage_label) },
        ]}
      />
      {picking_model && <ModelDialog run_id={run.id} stage_label={stage_label} stage_mode={stage_mode} on_close={() => set_picking_model(false)} />}
    </span>
  );
}
