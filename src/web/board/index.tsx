// The board: X-Libs' Board with a column for each stage, each open item a card in the column of the stage it is at,
// finished items in a Done column when shown, a lane per repository when asked, and the inbox of proposals above.
// Dragging a card back to an earlier column sends the item back there; stages move on only by a run's report.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Board, type BoardColumn, type BoardLane } from "@x-tech-laboratories/x-libs/web/react/board";
import { SearchBox, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { use_pref } from "@x-tech-laboratories/x-libs/web/react/prefs";
import { Empty, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";

import { proposed, type Item } from "../../shared/items/model.ts";
import type { StageRun } from "../../shared/runs/model.ts";
import { done, type Stage } from "../../shared/stages/model.ts";
import { data_watch, page, use_data } from "../api.ts";
import { Inbox, ItemDialog } from "../items/index.tsx";
import { card_tone, confirm_send_back, is_inner_control, item_href, ItemCard } from "./ItemCard.tsx";

// ── Moving ───────────────────────────────────────────────────────────────────

// Whether a card at one column may be sent back to another: only to a column before it, Done counting as the last.
export function is_send_back(stage_ids: string[], from: string, to: string): boolean {
  const index_of = (id: string) => (id === done ? stage_ids.length : stage_ids.indexOf(id));
  return from !== to && index_of(to) >= 0 && index_of(to) < index_of(from);
}

// ── Page ─────────────────────────────────────────────────────────────────────

const all_repositories = "";

const done_stage: Stage = { id: done, label: "Done", description: "Items that have been through every stage.", order: 0, next: done, model: "", effort: "", gates: [], max_proposals: 0, paths: [], tools: [], disallowed_tools: [], prompt: "" };

interface StageColumn extends BoardColumn {
  stage: Stage;
}

export function BoardView() {
  const { stages: stages_client, runner } = page();
  const [search, set_search] = useState("");
  const [repository, set_repository] = useState(all_repositories);
  const [show_done, set_show_done] = useState(false);
  const [by_repository, set_by_repository] = use_pref("x-dev-board-by-repository", false, (value): value is boolean => typeof value === "boolean");
  const [adding, set_adding] = useState(false);
  const items = use_data((api) => api.list_items(false));
  const runs = use_data((api) => api.list_stage_runs());
  const stages = use_resource(async () => (stages_client ? (await stages_client.list_stages()).stages : []), [stages_client], { watch: data_watch });
  const runner_status = use_resource(async () => (runner ? await runner.get_runner() : null), [runner], { watch: data_watch });
  // Each finished run's changed lines, read again only when the runs shown end or change.
  const finished_ids = (runs.data ?? []).filter((run) => run.state === "done" || run.state === "failed").map((run) => run.run_id);
  const changes = use_resource(async () => (runner && finished_ids.length ? await runner.list_run_changes(finished_ids) : {}), [runner, finished_ids.join(",")]);

  const stage_list = stages.data ?? [];
  const stage_ids = stage_list.map((stage) => stage.id);
  const needle = search.trim().toLowerCase();
  const shown = (items.data ?? []).filter(
    (item) =>
      item.stage !== proposed &&
      (show_done || item.stage !== done) &&
      (repository === all_repositories || item.repository === repository) &&
      (!needle || `${item.title} ${item.repository}`.toLowerCase().includes(needle)),
  );
  const stage_columns = show_done ? [...stage_list, done_stage] : stage_list;
  const column_of = (item: Item) => (stage_columns.some((stage) => stage.id === item.stage) ? item.stage : (stage_list[0]?.id ?? done));
  const columns: StageColumn[] =
    shown.length === 0
      ? []
      : stage_columns.map((stage) => ({ id: stage.id, label: stage.label, title: stage.description, count: shown.filter((item) => column_of(item) === stage.id).length, stage }));
  const lanes: BoardLane[] | undefined = by_repository
    ? [...new Set(shown.map((item) => item.repository))].sort().map((name) => {
        const [owner, short_name] = name.includes("/") ? name.split("/") : ["", name];
        return { id: name, label: name, head: <><span>{short_name}</span>{owner && <span className="muted small">{owner}</span>}</> };
      })
    : undefined;
  const can_run = runner_status.data?.running_run_id == null;
  const runs_of = (item: Item): StageRun[] => (runs.data ?? []).filter((run) => run.item_id === item.id);
  const stage_of = (item: Item) => stage_list.find((stage) => stage.id === item.stage);
  const failed = stages.error ?? items.error;
  const empty =
    stage_list.length === 0 ? (
      <Empty title="No stages." hint="Add the default stages under Settings → Pipeline → Stages." />
    ) : (
      <Empty title="No items on the board." hint={(items.data ?? []).length === 0 ? "Add a feature or bug fix to take it through the stages." : "Nothing matches the filters."} />
    );

  return (
    <>
      <PageHeading title="Board" />
      <Toolbar>
        <button type="button" className="accent solid" onClick={() => set_adding(true)}>
          Add Item
        </button>
        <SearchBox label="Search items" value={search} on_input={set_search} />
        <Select<string>
          label="Repository"
          bare
          options={[[all_repositories, "Every repository"], ...[...new Set((items.data ?? []).map((item) => item.repository))].sort().map((name): [string, string] => [name, name])]}
          value={repository}
          on_change={set_repository}
        />
        <Switch label="Show finished items" show_label checked={show_done} on_change={set_show_done} />
        <Switch label="Group by repository" show_label checked={by_repository} on_change={set_by_repository} />
      </Toolbar>
      <Inbox />
      <Board<Item, StageColumn>
        label="Board"
        columns={columns}
        lanes={lanes}
        lane_heading="Repository"
        loading={stages.loading || items.loading}
        error={failed ?? undefined}
        on_retry={() => void Promise.all([stages.reload(), items.reload()])}
        empty={empty}
        cards={{
          of: (lane, column) => shown.filter((item) => column_of(item) === column.id && (lane === null || item.repository === lane.id)),
          id: (item) => item.id,
          class_name: (item) => card_tone(stage_of(item), runs_of(item)),
          render: (item) => <ItemCard item={item} stage={stage_of(item)} stages={stage_list} runs={runs_of(item)} changes={changes.data ?? {}} can_run={can_run} />,
          on_open: (item, event) => {
            if (event.type === "click" && is_inner_control(event.target as HTMLElement)) return;
            window.location.hash = item_href(item, stage_of(item), runs_of(item)).slice(1);
          },
        }}
        can_move={(item, move) => is_send_back(stage_ids, column_of(item), move.to.id)}
        on_move={(item, move) => confirm_send_back(item, move.to.stage)}
      />
      {adding && <ItemDialog initial={null} on_close={() => set_adding(false)} />}
    </>
  );
}
