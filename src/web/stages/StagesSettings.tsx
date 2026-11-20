// The Stages section of Settings: every stage in pipeline order with its model, effort, permission mode and next stage, each edited in a
// dialog that writes its stage file back, and the default stages added where they are missing.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { ChipField, with_draft } from "@x-tech-laboratories/x-libs/web/react/chip_field";
import { NumberField, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormGroup, FormRow, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { ComboField } from "@x-tech-laboratories/x-libs/web/react/suggestions";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { run_mode_labels, run_modes, type RunMode } from "../../shared/runs/modes.ts";
import { default_max_proposals, done, efforts, gate_names, model_suggestions, tool_suggestions, type Effort, type Stage, type StageInput, type StagesMethods } from "../../shared/stages/model.ts";
import { attempt, data_watch, succeeds } from "../api.ts";
import { DialogButtons } from "../forms.tsx";
import { confirm_delete, row_actions_column } from "../rows.tsx";

// ── Dialog ───────────────────────────────────────────────────────────────────

function blank_stage(): StageInput {
  return { id: "", label: "", description: "", next: done, model: "", effort: "", mode: "", gates: ["report", "status"], max_proposals: default_max_proposals, paths: [], tools: [], disallowed_tools: [], prompt: "" };
}

function input_of(stage: Stage): StageInput {
  const { order: _order, ...input } = stage;
  return input;
}

type ListKey = "gates" | "paths" | "tools" | "disallowed_tools";

interface StageDialogProps {
  stages_client: Client<StagesMethods>;
  initial: Stage | null;
  others: Stage[];
  on_close: () => void;
}

export function StageDialog({ stages_client, initial, others, on_close }: StageDialogProps) {
  const [stage, set_stage] = useState<StageInput>(() => (initial ? input_of(initial) : blank_stage()));
  const [drafts, set_drafts] = useState<Record<ListKey, string>>({ gates: "", paths: "", tools: "", disallowed_tools: "" });
  const change = (changes: Partial<StageInput>) => set_stage((current) => ({ ...current, ...changes }));
  const draft_of = (key: ListKey) => ({ draft: drafts[key], on_draft: (draft: string) => set_drafts((current) => ({ ...current, [key]: draft })) });

  async function save(): Promise<void> {
    const with_drafts = { ...stage, gates: with_draft(stage.gates, drafts.gates), paths: with_draft(stage.paths, drafts.paths), tools: with_draft(stage.tools, drafts.tools), disallowed_tools: with_draft(stage.disallowed_tools, drafts.disallowed_tools) };
    if (await succeeds(() => stages_client.save_stage(with_drafts, initial?.id ?? null))) on_close();
  }

  const next_options: [string, string][] = [...others.map((other): [string, string] => [other.id, other.label]), [done, "Done"]];

  return (
    <Dialog title={initial ? `Edit ${initial.label}` : "Add Stage"} wide on_close={on_close} buttons={<DialogButtons on_save={() => void save()} on_cancel={on_close} />}>
      <div className="form-rows">
        <FormRow label="Id" id="stage-id">
          <input id="stage-id" type="text" placeholder="plan" value={stage.id} onChange={(event) => change({ id: event.currentTarget.value })} />
        </FormRow>
        <FormRow label="Name" id="stage-label">
          <input id="stage-label" type="text" placeholder="Plan" value={stage.label} onChange={(event) => change({ label: event.currentTarget.value })} />
        </FormRow>
        <FormRow label="Description" id="stage-description">
          <input id="stage-description" type="text" value={stage.description} onChange={(event) => change({ description: event.currentTarget.value })} />
        </FormRow>
        <FormRow label="Model" id="stage-model">
          <ComboField id="stage-model" label="Model" placeholder="The backend's default" value={stage.model} options={model_suggestions} list_on_focus on_change={(model) => change({ model })} />
        </FormRow>
        <FormRow label="Effort" id="stage-effort">
          <Select<Effort | ""> label="Effort" bare options={[["", "The model's default"], ...efforts.map((effort): [Effort, string] => [effort, effort])]} value={stage.effort} on_change={(effort) => change({ effort })} />
        </FormRow>
        <FormRow label="Permission mode" id="stage-mode" hint="How its runs' tool calls are approved unless a run picks another; Manual and Edit automatically ask you on the run's page.">
          <Select<RunMode | ""> label="Permission mode" bare options={[["", "As the runner's setting says"], ...run_modes.map((mode): [RunMode, string] => [mode, run_mode_labels[mode]])]} value={stage.mode} on_change={(mode) => change({ mode })} />
        </FormRow>
        <FormRow label="Next stage" id="stage-next">
          <Select<string> label="Next stage" bare options={next_options} value={stage.next} on_change={(next) => change({ next })} />
        </FormRow>
        <FormRow label="Gates" id="stage-gates">
          <ChipField id="stage-gates" label="Gates" placeholder="Add a gate…" values={stage.gates} suggestions={gate_names} list_on_focus on_change={(gates) => change({ gates })} {...draft_of("gates")} />
        </FormRow>
        <FormRow label="Most proposals" id="stage-max-proposals">
          <NumberField label="Most proposals" bare min={0} unit="per run, 0 for no limit" value={stage.max_proposals} on_change={(max_proposals) => change({ max_proposals: max_proposals ?? default_max_proposals })} />
        </FormRow>
        <FormRow label="Prompt" id="stage-prompt">
          <textarea id="stage-prompt" className="stage-prompt" rows={14} spellCheck={false} value={stage.prompt} onChange={(event) => change({ prompt: event.currentTarget.value })} />
        </FormRow>
        <FormGroup summary="Tools and paths">
          <FormRow label="May change" id="stage-paths">
            <ChipField id="stage-paths" label="May change" placeholder="Anything, unless paths are given" values={stage.paths} suggestions={["tests/**", "docs/**", "**/*.md"]} on_change={(paths) => change({ paths })} {...draft_of("paths")} />
          </FormRow>
          <FormRow label="Tools allowed" id="stage-tools">
            <ChipField id="stage-tools" label="Tools allowed" placeholder="Every tool, unless some are given" values={stage.tools} suggestions={tool_suggestions} on_change={(tools) => change({ tools })} {...draft_of("tools")} />
          </FormRow>
          <FormRow label="Tools refused" id="stage-disallowed-tools">
            <ChipField id="stage-disallowed-tools" label="Tools refused" placeholder="None" values={stage.disallowed_tools} suggestions={tool_suggestions} on_change={(disallowed_tools) => change({ disallowed_tools })} {...draft_of("disallowed_tools")} />
          </FormRow>
        </FormGroup>
      </div>
    </Dialog>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

export function StagesSettings({ stages_client }: { stages_client: Client<StagesMethods> }) {
  const list = use_resource(() => stages_client.list_stages(), [stages_client], { watch: data_watch });
  const [editing, set_editing] = useState<Stage | "new" | null>(null);

  async function add_defaults(): Promise<void> {
    const added = await attempt(() => stages_client.add_default_stages());
    if (added === undefined) return;
    data_watch.bump();
    toast(added === 0 ? "Every default stage is already here." : `Added ${added} ${added === 1 ? "stage" : "stages"}.`, { tone: "good" });
  }

  async function run(work: () => Promise<unknown>): Promise<void> {
    if (await succeeds(work)) data_watch.bump();
  }

  return (
    <Loaded resource={list}>
      {({ folder, stages, problems }) => {
        const label_of = (id: string) => (id === done ? "Done" : (stages.find((stage) => stage.id === id)?.label ?? id));
        const columns: TableColumn<Stage>[] = [
          { label: "Stage", cell: (stage) => <span title={stage.description}>{stage.label}</span> },
          { label: "Model", cell: (stage) => stage.model || "Default" },
          { label: "Effort", cell: (stage) => stage.effort || "Default" },
          { label: "Mode", cell: (stage) => (stage.mode ? run_mode_labels[stage.mode] : "Default") },
          { label: "Next", cell: (stage) => label_of(stage.next) },
          { label: "Gates", cell: (stage) => String(stage.gates.length) },
          row_actions_column<Stage>({
            name: (stage) => stage.label,
            edit: set_editing,
            buttons: (stage) => (
              <>
                <button type="button" aria-label={`Move ${stage.label} up`} disabled={stages[0]?.id === stage.id} onClick={() => void run(() => stages_client.move_stage(stage.id, -1))}>
                  Up
                </button>
                <button type="button" aria-label={`Move ${stage.label} down`} disabled={stages.at(-1)?.id === stage.id} onClick={() => void run(() => stages_client.move_stage(stage.id, 1))}>
                  Down
                </button>
              </>
            ),
            remove: (stage) => confirm_delete(`Delete ${stage.label}?`, `Its file, stage-${stage.id}.md, is removed, and the stage before it goes on to ${label_of(stage.next)}.`, () => run(() => stages_client.delete_stage(stage.id))),
          }),
        ];
        return (
          <>
            <p className="muted small">
              Stage files live in <code>{folder}</code>, where Claude Code reads them too.
            </p>
            <Toolbar>
              <button type="button" className="accent solid" onClick={() => set_editing("new")}>
                Add Stage
              </button>
              <button type="button" onClick={() => void add_defaults()}>
                Add the Default Stages
              </button>
            </Toolbar>
            {problems.map((problem) => (
              <p key={problem.file} className="danger small" role="alert">
                {problem.file} could not be read: {problem.problem}.
              </p>
            ))}
            {stages.length === 0 ? (
              <Empty title="No stages." hint="Add the default stages, or a stage of your own." />
            ) : (
              <DataTable columns={columns} rows={stages} row_key={(stage) => stage.id} />
            )}
            {editing && (
              <StageDialog
                key={editing === "new" ? "new" : editing.id}
                stages_client={stages_client}
                initial={editing === "new" ? null : editing}
                others={stages.filter((stage) => editing === "new" || stage.id !== editing.id)}
                on_close={() => {
                  set_editing(null);
                  data_watch.bump();
                }}
              />
            )}
          </>
        );
      }}
    </Loaded>
  );
}
