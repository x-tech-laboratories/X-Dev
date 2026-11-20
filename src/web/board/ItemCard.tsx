// One item as a board card, merged with the latest run of the stage it is at: its repository and issue, title,
// that run's state, summary, model, changed lines, cost, age and gates, a waiting run's question, a dot per stage for
// the way it came once it has runs, Run with a model picker, and a menu to open it, send it back or discard its last
// run. It draws only what goes inside the board's card; the board opens it on a click.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Badge, StatusPill, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { confirm_dialog, Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { MenuButton } from "@x-tech-laboratories/x-libs/web/react/menu_button";
import type { MenuItem } from "@x-tech-laboratories/x-libs/web/react/menus";
import { ComboField } from "@x-tech-laboratories/x-libs/web/react/suggestions";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { cx } from "@x-tech-laboratories/x-libs/web/dom";

import { read_pull_request, type CheckBucket, type PullRequest } from "../../shared/items/github.ts";
import { proposed, type Item } from "../../shared/items/model.ts";
import { path_marks, review_model_warning, type GateMark, type PathMark, type StageRun } from "../../shared/runs/model.ts";
import type { LineCounts } from "../../shared/runs/runner.ts";
import { done, model_suggestions, type Stage } from "../../shared/stages/model.ts";
import { calls, data_watch, page, succeeds } from "../api.ts";
import { run_state_labels } from "../items/ItemView.tsx";
import { RunDialog } from "./RunDialog.tsx";

// ── Gates ────────────────────────────────────────────────────────────────────

function gate_tone(mark: GateMark): Tone {
  if (mark.outcome === "failed") return mark.passed_over ? "warn" : "bad";
  return mark.outcome === "warning" ? "warn" : "good";
}

// The gates that need a look, each as a chip, and the ones that passed counted in one.
export function GateChips({ gates }: { gates: GateMark[] }) {
  if (gates.length === 0) return null;
  const flagged = gates.filter((mark) => mark.outcome !== "passed");
  const passed = gates.length - flagged.length;
  return (
    <div className="chips inline-chips card-gates" aria-label="Gates">
      {flagged.map((mark) => (
        <Badge key={mark.gate} tone={gate_tone(mark)} title={mark.passed_over ? "Failed, passed over by you" : mark.outcome}>
          {mark.outcome === "failed" && !mark.passed_over ? "✗" : "!"} {mark.gate}
        </Badge>
      ))}
      {passed > 0 && (
        <Badge tone="good" title={gates.filter((mark) => mark.outcome === "passed").map((mark) => mark.gate).join(", ")}>
          ✓ {passed === gates.length ? `all ${passed} gates` : `${passed} passed`}
        </Badge>
      )}
    </div>
  );
}

// ── Pull request ─────────────────────────────────────────────────────────────

const check_tones: Record<CheckBucket, Tone> = { pass: "good", fail: "bad", cancel: "bad", pending: "info", skipping: "none" };

const pull_request_tones: Record<PullRequest["state"], Tone> = { open: "info", merged: "good", closed: "none" };

// The item's pull request and how its checks stand, each outcome counted in one chip.
function PullRequestChips({ pull_request }: { pull_request: PullRequest }) {
  const counts = new Map<CheckBucket, number>();
  for (const check of pull_request.checks) counts.set(check.bucket, (counts.get(check.bucket) ?? 0) + 1);
  return (
    <div className="chips inline-chips card-gates" aria-label="Pull request">
      <a href={pull_request.url} target="_blank" rel="noreferrer">
        <Badge tone={pull_request_tones[pull_request.state]} title={`Pull request ${pull_request.state}${pull_request.draft ? ", a draft" : ""}`}>
          PR #{pull_request.number} {pull_request.state === "open" ? (pull_request.draft ? "draft" : "open") : pull_request.state}
        </Badge>
      </a>
      {[...counts].map(([bucket, count]) => (
        <Badge key={bucket} tone={check_tones[bucket]} title={pull_request.checks.filter((check) => check.bucket === bucket).map((check) => check.name).join(", ")}>
          {count} {bucket === "pass" ? "passed" : bucket === "fail" ? "failed" : bucket === "cancel" ? "cancelled" : bucket === "skipping" ? "skipped" : "running"}
        </Badge>
      ))}
    </div>
  );
}

// ── Sending back ─────────────────────────────────────────────────────────────

// Asks before moving the item back to an earlier stage, so that stage is the one its next run takes.
export function confirm_send_back(item: Item, stage: Stage): void {
  confirm_dialog({
    title: `Send “${item.title}” back to ${stage.label}?`,
    message: `The item moves to ${stage.label}, which its next run takes. Nothing runs yet and no run is undone.`,
    confirm_label: "Send Back",
    run: async () => void ((await succeeds(() => calls().send_item_back(item.id, stage.id), `Sent back to ${stage.label}.`)) && data_watch.bump()),
  });
}

// ── Model ────────────────────────────────────────────────────────────────────

// Runs the stage once on a model the user picks, warning when Review would repeat Implement's model.
function ModelDialog({ item, stage, runs, on_close }: { item: Item; stage: Stage; runs: StageRun[]; on_close: () => void }) {
  const { runner } = page();
  const [model, set_model] = useState("");
  const warning = review_model_warning(stage.id, model.trim() || stage.model, runs);
  async function run(): Promise<void> {
    if (await succeeds(() => runner!.start_run(item.id, { stage: stage.id, ...(model.trim() ? { model: model.trim() } : {}) }))) {
      data_watch.bump();
      on_close();
    }
  }
  return (
    <Dialog
      title={`Run ${stage.label} on Another Model`}
      subtitle={item.title}
      on_close={on_close}
      buttons={
        <>
          <button type="button" onClick={on_close}>
            Cancel
          </button>
          <button type="button" className="accent solid" onClick={() => void run()}>
            Run
          </button>
        </>
      }
    >
      <FormRow label="Model for this run" id="run-model">
        <ComboField label="Model for this run" placeholder={stage.model ? `${stage.model}, as the stage says` : "The stage's model"} value={model} options={model_suggestions} on_change={set_model} />
      </FormRow>
      {warning && (
        <p className="tone-warn" role="status">
          {warning}
        </p>
      )}
    </Dialog>
  );
}

// ── Questions ────────────────────────────────────────────────────────────────

// A waiting run's first question; a single question's choices answer it at once.
function Question({ run, on_open }: { run: StageRun; on_open: () => void }) {
  const { runner } = page();
  const first = run.questions[0];
  if (!first) return null;
  const answer = (choice: string) => void succeeds(() => runner!.answer_run(run.run_id, choice), "Answer sent.").then(() => data_watch.bump());
  return (
    <ul className="attention compact card-question">
      <li className="tone-edge-warn">
        <span>{first.question}</span>
        <span className="chips inline-chips">
          {runner &&
            run.questions.length === 1 &&
            first.choices.map((choice) => (
              <button key={choice} type="button" onClick={() => answer(choice)}>
                {choice}
              </button>
            ))}
          <button type="button" onClick={on_open}>
            {run.questions.length > 1 ? `Answer ${run.questions.length} Questions…` : "Answer…"}
          </button>
        </span>
      </li>
    </ul>
  );
}

// ── Path ─────────────────────────────────────────────────────────────────────

const path_tones: Record<PathMark, Tone> = { done: "good", failed: "bad", waiting: "warn", running: "info", stopped: "none", discarded: "none", skipped: "none", current: "info", ahead: "none" };

const path_words: Record<PathMark, string> = { done: "done", failed: "failed", waiting: "waiting for answers", running: "running", stopped: "stopped", discarded: "discarded", skipped: "skipped", current: "here, not run yet", ahead: "not reached" };

// An item with no runs yet has no way to show, so it draws no strip.
function PathStrip({ item, stages, runs }: { item: Item; stages: Stage[]; runs: StageRun[] }) {
  if (runs.length === 0) return null;
  const marks = path_marks(
    stages.map((stage) => stage.id),
    item.stage,
    runs,
  );
  return (
    <ol className="card-path" aria-label="Stages">
      {marks.map(({ stage, mark }) => {
        const label = `${stages.find((each) => each.id === stage)?.label ?? stage}: ${path_words[mark]}`;
        return (
          <li key={stage} title={label} aria-label={label} className={cx(mark === "ahead" && "card-path-ahead", stage === item.stage && "card-path-current")}>
            <span className={cx("status-dot", `tone-${path_tones[mark]}`, mark === "running" && "busy")} aria-hidden="true" />
          </li>
        );
      })}
    </ol>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

export interface ItemCardProps {
  item: Item;
  // The stage the item is at; missing once it has been through every stage.
  stage: Stage | undefined;
  // Every stage in order, for the strip of stage dots and the stages it can be sent back to.
  stages: Stage[];
  // The item's latest run of each stage, discarded ones left out.
  runs: StageRun[];
  // The lines each run changed, by run id, where they are known.
  changes?: Record<string, LineCounts>;
  // Whether the one run slot is free.
  can_run: boolean;
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// Clicks on the card's own buttons, links, menus and dialogs are theirs, not the card's.
export function is_inner_control(target: HTMLElement): boolean {
  return target.closest("button, a, input, textarea, select, label, [role=menu], [role=menuitem], dialog") !== null;
}

// The run of the stage the item is at, which its card shows.
function stage_run(stage: Stage | undefined, runs: StageRun[]): StageRun | undefined {
  return stage ? runs.find((each) => each.stage === stage.id) : undefined;
}

// Where the card opens: the item's page at the run it shows.
export function item_href(item: Item, stage: Stage | undefined, runs: StageRun[]): string {
  const run = stage_run(stage, runs);
  return `#/items/${encodeURIComponent(item.id)}${run ? `/${encodeURIComponent(run.run_id)}` : ""}`;
}

// The edge a card takes for a run that failed or waits for answers.
export function card_tone(stage: Stage | undefined, runs: StageRun[]): string | undefined {
  const state = stage_run(stage, runs)?.state;
  return state === "failed" ? "tone-edge-bad" : state === "waiting" ? "tone-edge-warn" : undefined;
}

export function ItemCard({ item, stage, stages, runs, changes = {}, can_run }: ItemCardProps) {
  const { runner } = page();
  const [dialog, set_dialog] = useState<"report" | "model" | null>(null);
  const run = stage_run(stage, runs);
  const latest = runs.reduce<StageRun | undefined>((newest, each) => (!newest || each.started_at > newest.started_at ? each : newest), undefined);
  const busy = run?.state === "running" || run?.state === "waiting";
  const can_start = Boolean(runner && stage) && can_run && !item.closed_at && item.stage !== proposed && item.stage !== done && !busy;
  const warning = can_start && stage ? review_model_warning(stage.id, stage.model, runs) : "";
  const counts = run ? changes[run.run_id] : undefined;
  // A run its gates held back says so in its gate chips, so the card keeps its report's summary.
  const held_by_gates = run?.gates.some((mark) => mark.outcome === "failed" && !mark.passed_over) ?? false;
  const at = stages.findIndex((each) => each.id === item.stage);
  const earlier = item.stage === done ? stages : stages.slice(0, Math.max(0, at));
  const href = item_href(item, stage, runs);
  const repository_name = item.repository.split("/")[1] ?? item.repository;
  const pull_request = read_pull_request(item.pull_request);

  function discard(): void {
    if (!latest) return;
    const label = stages.find((each) => each.id === latest.stage)?.label ?? latest.stage;
    confirm_dialog({
      title: `Discard the last ${label} run?`,
      message: "The worktree goes back to the commit the run started from, the status sheet to how it was, and the item to that stage. Proposals the run made that still wait in the inbox are dropped.",
      confirm_label: "Discard",
      danger: true,
      run: async () => void ((await succeeds(() => runner!.discard_run(latest.run_id))) && data_watch.bump()),
    });
  }

  const menu: MenuItem[] = [
    { label: "Open Item", run: () => (window.location.hash = href.slice(1)) },
    ...(run ? [{ label: "Open Report", run: () => set_dialog("report") }] : []),
    ...(can_start ? [{ label: `Run ${stage!.label} on Another Model…`, run: () => set_dialog("model") }] : []),
    ...(!item.closed_at && item.stage !== proposed ? earlier.map((each, index) => ({ label: `Send Back to ${each.label}`, separator_before: index === 0, run: () => confirm_send_back(item, each) })) : []),
    ...(runner && latest && latest.state !== "running" ? [{ label: "Discard Last Run", danger: true, separator_before: true, run: discard }] : []),
  ];

  return (
    <article className="item-card" aria-label={item.title}>
      <div className="card-top small muted">
        <span>
          {repository_name}
          {item.issue_number !== null && ` #${item.issue_number}`}
        </span>
        <MenuButton label={`More for ${item.title}`} items={menu} />
      </div>
      <div className="board-card-title">{item.title}</div>
      {run ? (
        <>
          <div className="card-run">
            <StatusPill tone={run_state_labels[run.state][1]} busy={run.state === "running"} label={run_state_labels[run.state][0]} />
            {run.state === "failed" && run.error && !held_by_gates ? <span className="tone-bad card-line">{run.error.split("\n")[0]}</span> : run.summary && <span className="card-line">{run.summary}</span>}
          </div>
          <div className="card-meta muted">
            {run.model && <Badge>{run.model}</Badge>}
            {counts && counts.additions + counts.deletions > 0 && (
              <span>
                <span className="tone-good">+{counts.additions}</span> <span className="tone-bad">−{counts.deletions}</span>
              </span>
            )}
            {run.cost_usd > 0 && <span>{money(run.cost_usd)}</span>}
            <Age epoch={Date.parse(run.ended_at ?? run.started_at) / 1000} />
          </div>
          <GateChips gates={run.gates} />
          {run.state === "waiting" && <Question run={run} on_open={() => set_dialog("report")} />}
        </>
      ) : (
        stage && <span className="card-line muted small">Not run yet{stage.model ? ` · ${stage.model}` : ""}</span>
      )}
      {pull_request && <PullRequestChips pull_request={pull_request} />}
      <PathStrip item={item} stages={stages} runs={runs} />
      {can_start && (
        <div className="card-actions">
          <button type="button" className="accent solid" aria-label={`Run ${stage!.label} on ${item.title}`} onClick={() => void succeeds(() => runner!.start_run(item.id, {})).then(() => data_watch.bump())}>
            Run {stage!.label}
          </button>
          <button type="button" onClick={() => set_dialog("model")}>
            Model…
          </button>
          {warning && <span className="tone-warn small">{warning}</span>}
        </div>
      )}
      {dialog === "report" && run && stage && <RunDialog run_id={run.run_id} stage_label={stage.label} item_title={item.title} on_close={() => set_dialog(null)} />}
      {dialog === "model" && stage && <ModelDialog item={item} stage={stage} runs={runs} on_close={() => set_dialog(null)} />}
    </article>
  );
}
