// One item's page: what it asks for, its status sheet, the notes for its next run, the controls that start a stage,
// and every run with its report, its questions, its transcript and what can still be done with it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { StateBadge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog, Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Facts, FormGroup, FormRow, PageHeading, Section, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Markdown } from "@x-tech-laboratories/x-libs/web/react/markdown";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { ComboField } from "@x-tech-laboratories/x-libs/web/react/suggestions";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { format_count } from "@x-tech-laboratories/x-libs/web/format";

import type { GateOutcome } from "../../shared/gates/model.ts";
import { issue_link, status_sections, type Item, type StatusSheet } from "../../shared/items/model.ts";
import { can_retry } from "../../shared/runs/attempts.ts";
import { review_model_warning, type Run } from "../../shared/runs/model.ts";
import { done, model_suggestions, type Stage } from "../../shared/stages/model.ts";
import { calls, data_watch, page, succeeds, use_data } from "../api.ts";
import { DialogButtons } from "../forms.tsx";
import { LiveRun, RunningButtons } from "../live/LiveRun.tsx";
import { mode_option, ModePicker } from "../live/ModePicker.tsx";
import type { RunMode } from "../../shared/runs/modes.ts";
import { confirm_retry_from_clean, RetryButton } from "../live/RetryButton.tsx";
import { read_transcript } from "../../shared/runs/transcript.ts";
import { ChangesView, changes_key } from "../changes/ChangesView.tsx";
import { link_issue } from "./index.tsx";
import { PullRequestPanel } from "./PullRequestPanel.tsx";
import { run_state_labels, stage_label } from "./words.ts";

// ── Words ────────────────────────────────────────────────────────────────────

const gate_labels: Record<GateOutcome, [string, Tone]> = {
  passed: ["Passed", "good"],
  failed: ["Failed", "bad"],
  warning: ["Warning", "warn"],
  skipped: ["Not checked", "none"],
};

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ── Status sheet ─────────────────────────────────────────────────────────────

function StatusDialog({ item, on_close }: { item: Item; on_close: () => void }) {
  const [sheet, set_sheet] = useState<StatusSheet>(item.status);
  async function save(): Promise<void> {
    if (await succeeds(() => calls().update_item_status(item.id, sheet))) on_close();
  }
  return (
    <Dialog title="Edit the Status Sheet" wide on_close={on_close} buttons={<DialogButtons on_save={() => void save()} on_cancel={on_close} />}>
      <div className="form-rows">
        {status_sections.map((section) => (
          <FormRow key={section.key} label={section.label} id={`status-${section.key}`}>
            <textarea id={`status-${section.key}`} rows={3} value={sheet[section.key]} onChange={(event) => set_sheet({ ...sheet, [section.key]: event.currentTarget.value })} />
          </FormRow>
        ))}
      </div>
    </Dialog>
  );
}

function StatusSheetSection({ item }: { item: Item }) {
  const [editing, set_editing] = useState(false);
  return (
    <Section
      title="Status sheet"
      tools={
        <button type="button" onClick={() => set_editing(true)}>
          Edit
        </button>
      }
    >
      <Facts layout="rows" rows={status_sections.map((section) => [section.label, item.status[section.key] ? <Markdown text={item.status[section.key]} /> : <span className="muted">Nothing yet.</span>])} />
      {editing && <StatusDialog item={item} on_close={() => set_editing(false)} />}
    </Section>
  );
}

// ── Notes ────────────────────────────────────────────────────────────────────

function NotesSection({ item }: { item: Item }) {
  const [notes, set_notes] = useState(item.notes);
  return (
    <Section title="Notes for the next run">
      <textarea aria-label="Notes for the next run" rows={3} placeholder="Corrections, answers or a change of scope the next stage should know" value={notes} onChange={(event) => set_notes(event.currentTarget.value)} />
      <Toolbar>
        <button type="button" disabled={notes.trim() === item.notes} onClick={() => void succeeds(() => calls().save_item_notes(item.id, notes), "Notes saved.")}>
          Save Notes
        </button>
      </Toolbar>
    </Section>
  );
}

// ── Starting ─────────────────────────────────────────────────────────────────

function RunControls({ item, stages, runs, busy }: { item: Item; stages: Stage[]; runs: Run[]; busy: boolean }) {
  const { runner } = page();
  const [stage_id, set_stage_id] = useState(item.stage === done || item.stage === "proposed" ? (stages[0]?.id ?? "") : item.stage);
  const [model, set_model] = useState("");
  const [mode, set_mode] = useState<RunMode | "">("");
  const stage = stages.find((each) => each.id === stage_id);
  const warning = review_model_warning(stage_id, model.trim() || stage?.model || "", runs);
  const chosen_model = { ...(model.trim() ? { model: model.trim() } : {}), ...mode_option(mode) };
  // The stage's latest run, which the primary button retries when it failed or was stopped.
  const latest = runs.find((run) => run.stage === stage_id && run.state !== "discarded");
  const retryable = latest && can_retry(latest) ? latest : undefined;
  if (!runner) return <p className="muted">Runs start from the desktop app, whose background process holds the checkouts and runs the agents.</p>;
  if (item.closed_at) return <p className="muted">This item is closed.</p>;
  if (item.stage === "proposed") return <p className="muted">Take this proposal from the inbox before running it.</p>;
  if (stages.length === 0) return <p className="muted">Add stages under Settings → Pipeline → Stages first.</p>;

  return (
    <Toolbar>
      <Select<string> label="Stage to run" options={stages.map((each): [string, string] => [each.id, each.id === item.stage ? `${each.label} (current)` : each.label])} value={stage_id} on_change={set_stage_id} />
      <ComboField label="Model for this run" placeholder={stage?.model ? `${stage.model}, as the stage says` : "The stage's model"} value={model} options={model_suggestions} on_change={set_model} />
      <ModePicker stage_mode={stage?.mode ?? ""} value={mode} on_change={set_mode} />
      {retryable ? (
        <>
          <button type="button" className="accent solid" disabled={busy} title={busy ? "A run is under way" : "Run the stage again on the worktree as the last run left it, telling it what went wrong"} onClick={() => void succeeds(() => runner.retry_run(retryable.id, chosen_model)).then(() => data_watch.bump())}>
            Retry {stage?.label ?? "Stage"}
          </button>
          <button type="button" disabled={busy} onClick={() => confirm_retry_from_clean(retryable.id, stage?.label ?? "the stage", chosen_model)}>
            Retry from Clean…
          </button>
        </>
      ) : (
        <button type="button" className="accent solid" disabled={busy || !stage} title={busy ? "A run is under way" : undefined} onClick={() => void succeeds(() => runner.start_run(item.id, { stage: stage_id, ...chosen_model })).then(() => data_watch.bump())}>
          Run {stage?.label ?? "Stage"}
        </button>
      )}
      {warning && <span className="tone-warn small" role="status">{warning}</span>}
    </Toolbar>
  );
}

// ── Gates ────────────────────────────────────────────────────────────────────

function OverrideDialog({ run, gate, on_close }: { run: Run; gate: string; on_close: () => void }) {
  const [reason, set_reason] = useState("");
  async function save(): Promise<void> {
    if (await succeeds(() => calls().override_gate(run.id, gate, reason))) on_close();
  }
  return (
    <Dialog title={`Pass Over the ${gate} Gate`} on_close={on_close} buttons={<DialogButtons can_save={reason.trim() !== ""} on_save={() => void save()} on_cancel={on_close} />}>
      <p className="muted">The reason is added to the run's report, so the next stage reads it.</p>
      <textarea aria-label="Why it can be passed over" rows={4} value={reason} onChange={(event) => set_reason(event.currentTarget.value)} />
    </Dialog>
  );
}

function Gates({ run }: { run: Run }) {
  const [overriding, set_overriding] = useState<string | null>(null);
  if (!run.gates.length) return null;
  const has_failed = run.gates.some((result) => result.outcome === "failed" || result.outcome === "warning");
  return (
    <FormGroup summary="Gates" open={has_failed}>
      <ul className="gates">
        {run.gates.map((result) => {
          const override = run.overrides.find((each) => each.gate === result.gate);
          return (
            <li key={result.gate}>
              <strong>{result.gate}</strong> <StateBadge labels={gate_labels} state={result.outcome} />
              {override && <span className="small"> · passed over: {override.reason}</span>}
              {result.findings.length > 0 && (
                <ul className="small">
                  {result.findings.map((finding) => (
                    <li key={finding}>{finding}</li>
                  ))}
                </ul>
              )}
              {result.outcome === "failed" && !override && run.state === "failed" && (
                <button type="button" onClick={() => set_overriding(result.gate)}>
                  Pass Over…
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {overriding && <OverrideDialog run={run} gate={overriding} on_close={() => set_overriding(null)} />}
    </FormGroup>
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────

function ReportDialog({ run, on_close }: { run: Run; on_close: () => void }) {
  const [report, set_report] = useState(run.report);
  async function save(): Promise<void> {
    if (await succeeds(() => calls().update_run_report(run.id, report))) on_close();
  }
  return (
    <Dialog title="Edit the Report" wide on_close={on_close} buttons={<DialogButtons on_save={() => void save()} on_cancel={on_close} />}>
      <textarea aria-label="Report" className="stage-prompt" rows={16} value={report} onChange={(event) => set_report(event.currentTarget.value)} />
    </Dialog>
  );
}

export function Answers({ run }: { run: Run }) {
  const { runner } = page();
  const [answers, set_answers] = useState("");
  return (
    <div className="run-questions">
      <ol>
        {run.questions.map((question) => (
          <li key={question.question}>
            <strong>{question.question}</strong>
            {question.why && <div className="muted small">{question.why}</div>}
            {question.choices.length > 0 && <div className="small">Choices: {question.choices.join(" · ")}</div>}
          </li>
        ))}
      </ol>
      {runner && (
        <>
          <textarea aria-label="Your answers" rows={3} placeholder="Answer each question, by its number" value={answers} onChange={(event) => set_answers(event.currentTarget.value)} />
          <Toolbar>
            <button type="button" className="accent solid" disabled={!answers.trim()} onClick={() => void succeeds(() => runner.answer_run(run.id, answers)).then(() => data_watch.bump())}>
              Send Answers
            </button>
          </Toolbar>
        </>
      )}
    </div>
  );
}

interface RunCardProps {
  run: Run;
  stages: Stage[];
  is_latest: boolean;
  // Whether it is its stage's latest run, which Retry is offered on.
  is_stage_latest: boolean;
  // Whether the page was opened at this run, which shows its report.
  focused?: boolean;
}

function RunCard({ run, stages, is_latest, is_stage_latest, focused = false }: RunCardProps) {
  const { runner } = page();
  const [editing_report, set_editing_report] = useState(false);
  const label = stage_label(stages, run.stage);

  function discard(): void {
    confirm_dialog({
      title: `Discard this ${label} run?`,
      message: "The worktree goes back to the commit the run started from, the status sheet to how it was, and the item to this stage. Proposals the run made that still wait in the inbox are dropped.",
      confirm_label: "Discard",
      danger: true,
      run: async () => void (await succeeds(() => runner!.discard_run(run.id))),
    });
  }

  return (
    <Section
      title={
        <>
          {run.attempt > 1 ? `Attempt ${run.attempt} of ${label}` : label} <StateBadge labels={run_state_labels} state={run.state} />
        </>
      }
      level={3}
      class_name={run.state === "discarded" ? "run discarded" : "run"}
      tools={
        runner && (
          <>
            <RunningButtons run={run} can_interrupt={read_transcript(run.transcript).activity === "working"} />
            {is_stage_latest && can_retry(run) && <RetryButton run={run} stage_label={label} />}
            {is_latest && run.state !== "running" && run.state !== "discarded" && (
              <button type="button" className="danger" onClick={discard}>
                Discard
              </button>
            )}
          </>
        )
      }
    >
      <Facts
        rows={[
          ["Started", <Age key="started" epoch={Date.parse(run.started_at) / 1000} />],
          ["Model", run.model || "Default"],
          run.effort ? ["Effort", run.effort] : null,
          ["Cost", money(run.cost_usd)],
          run.input_tokens + run.output_tokens > 0 ? ["Tokens", `${format_count(run.input_tokens)} read, ${format_count(run.output_tokens)} written`] : null,
          run.proposals > 0 ? ["Proposals", String(run.proposals)] : null,
        ]}
      />
      {run.error && (
        <p className="danger" role="alert">
          {run.error}
        </p>
      )}
      {run.state === "waiting" && <Answers run={run} />}
      <Gates run={run} />
      {run.report && (
        <FormGroup summary="Report" open={is_latest || focused}>
          <Markdown text={run.report} />
          {run.state === "done" && (
            <Toolbar>
              <button type="button" onClick={() => set_editing_report(true)}>
                Edit Report
              </button>
            </Toolbar>
          )}
        </FormGroup>
      )}
      <FormGroup summary="Transcript" open={run.state === "running" || focused}>
        <LiveRun run={run} stage_label={label} is_latest={is_stage_latest} standalone={false} />
      </FormGroup>
      {editing_report && <ReportDialog run={run} on_close={() => set_editing_report(false)} />}
    </Section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function ItemView({ id, run_id }: { id: string; run_id?: string }) {
  const { stages: stages_client, runner } = page();
  const item = use_data((api) => api.get_item(id), [id]);
  const runs = use_data((api) => api.list_runs(id), [id]);
  const stages = use_resource(async () => (stages_client ? (await stages_client.list_stages()).stages : []), [stages_client], { watch: data_watch });
  const runner_status = use_resource(async () => (runner ? await runner.get_runner() : null), [runner], { watch: data_watch });
  const runs_loaded = runs.data !== null;
  useEffect(() => {
    if (run_id && runs_loaded) document.getElementById(`run-${run_id}`)?.scrollIntoView({ block: "start" });
  }, [run_id, runs_loaded]);

  return (
    <Loaded resource={item}>
      {(found) => {
        const link = issue_link(found);
        const all_stages = stages.data ?? [];
        const run_list = runs.data ?? [];
        const latest = run_list.find((run) => run.state !== "discarded");
        return (
          <>
            <PageHeading
              title={found.title}
              subtitle={
                <>
                  {found.repository}
                  {link && (
                    <>
                      {" · "}
                      <a href={link} target="_blank" rel="noreferrer">
                        #{found.issue_number}
                      </a>
                    </>
                  )}
                  {" · "}
                  {stage_label(all_stages, found.stage)}
                </>
              }
              actions={
                <>
                  {runner && found.issue_number === null && found.stage !== "proposed" && (
                    <button type="button" onClick={() => void link_issue(found.id)}>
                      Find or Open an Issue
                    </button>
                  )}
                  <a href="#/items">All items</a>
                </>
              }
            />
            {found.body && <Markdown text={found.body} />}
            <RunControls key={found.stage} item={found} stages={all_stages} runs={run_list} busy={runner_status.data?.running_run_id != null} />
            <StatusSheetSection item={found} />
            <PullRequestPanel item={found} />
            <NotesSection key={found.notes} item={found} />
            <Section title="Runs">
              {run_list.length === 0 ? <p className="muted">No runs yet.</p> : run_list.map((run) => <div key={run.id} id={`run-${run.id}`}><RunCard run={run} stages={all_stages} is_latest={run.id === latest?.id} is_stage_latest={run.id === run_list.find((each) => each.stage === run.stage && each.state !== "discarded")?.id} focused={run.id === run_id} /></div>)}
            </Section>
            <Section title="Changes">
              <ChangesView key={found.branch} item_id={found.id} runs={run_list.filter((run) => run.state !== "discarded")} refresh_key={changes_key(run_list)} />
            </Section>
          </>
        );
      }}
    </Loaded>
  );
}
