// One run as it happens, or as it went: a header with its state, model, time taken, tokens and cost, Stop and Interrupt
// while it runs, Retry once it failed or was stopped, the transcript of its steps, and a box to write to the agent while
// its session is open. The plain output stays one click away.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { format_duration } from "@x-tech-laboratories/x-libs/durations";
import { format_count } from "@x-tech-laboratories/x-libs/web/format";
import { Badge, StateBadge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { FollowingOutput } from "@x-tech-laboratories/x-libs/web/react/following";
import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { FormGroup, Tabs, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";

import { can_retry } from "../../shared/runs/attempts.ts";
import type { Run } from "../../shared/runs/model.ts";
import { mode_of_session, run_mode_labels, run_modes, type RunMode } from "../../shared/runs/modes.ts";
import { read_transcript } from "../../shared/runs/transcript.ts";
import { data_watch, page, succeeds } from "../api.ts";
import { run_state_labels } from "../items/words.ts";
import { TranscriptView } from "../transcript/TranscriptView.tsx";
import { ChangesView, changes_key } from "../changes/ChangesView.tsx";
import { RetryButton } from "./RetryButton.tsx";

// ── Time ─────────────────────────────────────────────────────────────────────

// The time now, read again every second while asked to tick.
function use_now(ticking: boolean): number {
  const [now, set_now] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => set_now(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

// ── Pieces ───────────────────────────────────────────────────────────────────

// Stop ends the run as it stands; Interrupt halts its current step and leaves the session waiting for a message.
export function RunningButtons({ run, can_interrupt }: { run: Pick<Run, "id" | "state">; can_interrupt: boolean }) {
  const { runner } = page();
  if (!runner || (run.state !== "running" && run.state !== "waiting")) return null;
  return (
    <>
      {run.state === "running" && (
        <button type="button" disabled={!can_interrupt} title={can_interrupt ? "Halt the current step; the session waits for your message" : "Already halted"} onClick={() => void succeeds(() => runner.interrupt_run(run.id))}>
          Interrupt
        </button>
      )}
      <button type="button" className="danger" onClick={() => void succeeds(() => runner.stop_run(run.id)).then(() => data_watch.bump())}>
        Stop
      </button>
    </>
  );
}

function MessageBox({ run_id, paused }: { run_id: string; paused: boolean }) {
  const { runner } = page();
  const [text, set_text] = useState("");
  async function send(): Promise<void> {
    if (await succeeds(() => runner!.interject_run(run_id, text))) set_text("");
  }
  return (
    <form
      className="transcript-message"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        aria-label="Message to the agent"
        rows={2}
        placeholder={paused ? "The agent is halted; say how to go on" : "Steer the agent; it reads this after its current step"}
        value={text}
        onChange={(event) => set_text(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <button type="submit" className="accent solid" disabled={!text.trim()}>
        Send
      </button>
    </form>
  );
}

// The run's permission mode, switched while its session is open.
function ModeSwitch({ run_id, mode }: { run_id: string; mode: RunMode | "" }) {
  const { runner } = page();
  const options: [RunMode | "", string][] = [...(mode ? [] : [["", "Another mode"] as [RunMode | "", string]]), ...run_modes.map((each): [RunMode, string] => [each, run_mode_labels[each]])];
  return <Select<RunMode | ""> label="Permission mode" bare options={options} value={mode} on_change={(next) => void (next && succeeds(() => runner!.set_run_mode(run_id, next)))} />;
}

// ── View ─────────────────────────────────────────────────────────────────────

interface LiveRunProps {
  run: Run;
  stage_label: string;
  // Whether this is the stage's latest run, the only one that can be retried.
  is_latest: boolean;
  // Whether it stands alone with a header of its state, cost and controls, rather than inside a run's own panel.
  standalone?: boolean;
}

export function LiveRun({ run, stage_label, is_latest, standalone = true }: LiveRunProps) {
  const { runner } = page();
  const [tab, set_tab] = useState<"transcript" | "changes">("transcript");
  const transcript = read_transcript(run.transcript);
  const running = run.state === "running";
  const session_open = running && transcript.activity !== "ended";
  const paused = session_open && transcript.activity === "paused";
  const now = use_now(running);
  const elapsed = Math.max(0, Math.round(((run.ended_at ? Date.parse(run.ended_at) : now) - Date.parse(run.started_at)) / 1000));
  const model = transcript.model || run.model || "Default model";
  const mode = mode_of_session(transcript.mode || run.permission_mode);
  const mode_control = runner && session_open ? <ModeSwitch run_id={run.id} mode={mode} /> : mode && <span className="small muted">{run_mode_labels[mode]}</span>;
  const awaiting = running && run.awaiting ? <Badge tone="warn">Waiting for approval: {run.awaiting}</Badge> : null;

  return (
    <div className="live-run">
      {standalone ? (
        <div className="spread-row">
          <div className="inline-row">
            <StateBadge labels={run_state_labels} state={run.state} />
            {paused && <Badge tone="warn">Halted, waiting for your message</Badge>}
            {awaiting}
            <span className="small">{model}</span>
            {mode_control}
            <span className="small muted">{format_duration(elapsed)}</span>
            {run.input_tokens + run.output_tokens > 0 && (
              <span className="small muted">
                {format_count(run.input_tokens)} read, {format_count(run.output_tokens)} written
              </span>
            )}
            <span className="small muted">${run.cost_usd.toFixed(2)}</span>
          </div>
          <Toolbar>
            <RunningButtons run={run} can_interrupt={session_open && !paused} />
            {runner && is_latest && can_retry(run) && <RetryButton run={run} stage_label={stage_label} />}
          </Toolbar>
        </div>
      ) : (
        running && (
          <div className="inline-row">
            {paused && <Badge tone="warn">Halted, waiting for your message</Badge>}
            {awaiting}
            <span className="small muted">
              {model} · {format_duration(elapsed)}
            </span>
            {mode_control}
          </div>
        )
      )}
      {runner && (
        <Tabs<"transcript" | "changes">
          label="Show"
          items={[
            { id: "transcript", label: "Transcript" },
            { id: "changes", label: "Changes" },
          ]}
          active={tab}
          on_select={set_tab}
        />
      )}
      {tab === "changes" ? (
        <ChangesView item_id={run.item_id} runs={[run]} run_id={run.id} refresh_key={changes_key([run])} />
      ) : (
        <>
          {run.transcript ? (
            <TranscriptView
              entries={transcript.entries}
              dropped={transcript.dropped}
              live={running}
              empty_text="The agent has not started yet."
              user_labels={{ input: `What ${stage_label} was given` }}
              on_permission={runner && session_open ? (request_id, decision, message) => void succeeds(() => runner.answer_permission(run.id, request_id, decision, message)) : undefined}
            />
          ) : (
            <FollowingOutput text={run.output || "Nothing yet."} active={running} toggle />
          )}
          {runner && session_open && <MessageBox run_id={run.id} paused={paused} />}
          {run.transcript && run.output && (
            <FormGroup summary="Plain output">
              <FollowingOutput text={run.output} active={running} />
            </FormGroup>
          )}
        </>
      )}
    </div>
  );
}
