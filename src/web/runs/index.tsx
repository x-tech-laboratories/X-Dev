// The Runs page: every run across every item in one table, filtered by words and state, each row opening its item at
// that run, under the tokens and cost summed by stage and by model, so a costly choice shows.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { format_duration } from "@x-tech-laboratories/x-libs/durations";
import { format_count } from "@x-tech-laboratories/x-libs/web/format";
import { Badge, StateBadge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Meters } from "@x-tech-laboratories/x-libs/web/react/charts";
import { SearchBox, Segmented, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Section, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";

import { gate_verdict, run_states, sum_runs_by, type CostTotal, type RunState, type RunSummary } from "../../shared/runs/model.ts";
import type { Stage } from "../../shared/stages/model.ts";
import { data_watch, page, use_data } from "../api.ts";
import { run_state_labels, stage_label } from "../items/ItemView.tsx";

// ── Words ────────────────────────────────────────────────────────────────────

type Measure = "cost" | "tokens";

const verdict_tones: Record<ReturnType<typeof gate_verdict>, Tone> = { failed: "bad", "passed over": "warn", passed: "good", none: "none" };

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function tokens_of(run: RunSummary): number {
  return run.input_tokens + run.output_tokens;
}

// How long a run took, or has taken so far while it runs.
export function duration_of(run: Pick<RunSummary, "started_at" | "ended_at">, now = Date.now()): number {
  const end = run.ended_at ? Date.parse(run.ended_at) : now;
  return Math.max(0, Math.round((end - Date.parse(run.started_at)) / 1000));
}

// ── Totals ───────────────────────────────────────────────────────────────────

function Totals({ title, totals, measure, name_of }: { title: string; totals: CostTotal[]; measure: Measure; name_of: (key: string) => string }) {
  const value = (total: CostTotal) => (measure === "cost" ? total.cost_usd : total.tokens);
  const sorted = [...totals].sort((first, second) => value(second) - value(first));
  const top = Math.max(0, ...sorted.map(value));
  return (
    <Section title={title} level={3}>
      <Meters
        message="No runs yet."
        rows={sorted.map((total) => ({
          label: name_of(total.key),
          href: null,
          value_text: `${measure === "cost" ? money(total.cost_usd) : format_count(total.tokens)} · ${total.runs} run${total.runs === 1 ? "" : "s"}`,
          percent: top > 0 ? (value(total) / top) * 100 : 0,
          color: "var(--series-1)",
          marks: [],
          title: `${money(total.cost_usd)}, ${format_count(total.tokens)} tokens over ${total.runs} runs`,
        }))}
      />
    </Section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const any_state = "";

export function RunsView() {
  const { stages: stages_client } = page();
  const [search, set_search] = useState("");
  const [state, set_state] = useState<RunState | "">(any_state);
  const [measure, set_measure] = useState<Measure>("cost");
  const runs = use_data((api) => api.list_run_summaries());
  const stages = use_resource(async () => (stages_client ? (await stages_client.list_stages()).stages : []), [stages_client], { watch: data_watch });
  const stage_list: Stage[] = stages.data ?? [];
  const label_of = (id: string) => stage_label(stage_list, id);

  const columns: TableColumn<RunSummary>[] = [
    { id: "item", label: "Item", cell: (run) => run.item_title, text: (run) => `${run.item_title} ${run.repository}`, sort: (run) => run.item_title.toLowerCase() },
    { id: "stage", label: "Stage", cell: (run) => label_of(run.stage), text: (run) => label_of(run.stage), sort: (run) => stage_list.findIndex((stage) => stage.id === run.stage) },
    { id: "model", label: "Model", cell: (run) => run.model || "Default", text: (run) => run.model },
    { id: "state", label: "State", cell: (run) => <StateBadge labels={run_state_labels} state={run.state} title={run.error || undefined} />, text: (run) => run_state_labels[run.state][0], sort: (run) => run.state },
    { id: "started", label: "Started", cell: (run) => <Age epoch={Date.parse(run.started_at) / 1000} />, sort: (run) => run.started_at, filterable: false },
    { id: "duration", label: "Duration", cell: (run) => format_duration(duration_of(run)), sort: (run) => duration_of(run), filterable: false },
    { id: "tokens", label: "Tokens", cell: (run) => format_count(tokens_of(run)), sort: tokens_of, filterable: false },
    { id: "cost", label: "Cost", cell: (run) => money(run.cost_usd), sort: (run) => run.cost_usd, filterable: false },
    {
      id: "gates",
      label: "Gates",
      cell: (run) => {
        const verdict = gate_verdict(run);
        return verdict === "none" ? <span className="muted">None</span> : <Badge tone={verdict_tones[verdict]}>{verdict === "failed" ? `${run.gates_failed - run.gates_passed_over} failed` : verdict === "passed over" ? "Passed over" : "Passed"}</Badge>;
      },
      text: gate_verdict,
    },
  ];

  return (
    <>
      <PageHeading title="Runs" subtitle="Every stage run on every item, with what it cost." />
      <Loaded resource={runs}>
        {(all) => {
          if (all.length === 0) return <Empty title="No runs yet." hint="Runs start from an item's page or the board." />;
          const needle = search.trim().toLowerCase();
          const shown = all.filter((run) => (state === any_state || run.state === state) && (!needle || `${run.item_title} ${run.repository} ${label_of(run.stage)} ${run.model}`.toLowerCase().includes(needle)));
          return (
            <>
              <Toolbar>
                <SearchBox label="Search runs" value={search} on_input={set_search} />
                <Select<RunState | "">
                  label="State"
                  options={[[any_state, "Every state"], ...run_states.map((each): [RunState, string] => [each, run_state_labels[each][0]])]}
                  value={state}
                  on_change={set_state}
                />
                <Segmented<Measure>
                  label="Sum"
                  choices={[
                    { value: "cost", label: "Cost" },
                    { value: "tokens", label: "Tokens" },
                  ]}
                  value={measure}
                  on_change={set_measure}
                />
              </Toolbar>
              <div className="runs-totals" role="group" aria-label="Totals">
                <Totals title="By stage" totals={sum_runs_by(shown, "stage")} measure={measure} name_of={(key) => label_of(key)} />
                <Totals title="By model" totals={sum_runs_by(shown, "model")} measure={measure} name_of={(key) => key} />
              </div>
              <DataTable
                caption="Runs"
                columns={columns}
                rows={shown}
                row_key={(run) => run.id}
                row_title={(run) => run.error || undefined}
                on_row_click={(run) => {
                  window.location.hash = `/items/${encodeURIComponent(run.item_id)}/${encodeURIComponent(run.id)}`;
                }}
                wrap_class="scroll"
              />
            </>
          );
        }}
      </Loaded>
    </>
  );
}
