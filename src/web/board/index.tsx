// The board: a column for each stage, each open item a card in the column of the stage it is at, finished items in a
// Done column when shown, lanes per repository when asked, and the inbox of proposals above. Dragging a card back to
// an earlier column sends the item back there; stages move on only by a run's report.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Fragment, useState, type DragEvent } from "react";
import { SearchBox, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { use_pref } from "@x-tech-laboratories/x-libs/web/react/prefs";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { cx } from "@x-tech-laboratories/x-libs/web/dom";

import { proposed, type Item } from "../../shared/items/model.ts";
import type { StageRun } from "../../shared/runs/model.ts";
import { done, type Stage } from "../../shared/stages/model.ts";
import { data_watch, page, use_data } from "../api.ts";
import { Inbox, ItemDialog } from "../items/index.tsx";
import { confirm_send_back, ItemCard } from "./ItemCard.tsx";

// ── Moving ───────────────────────────────────────────────────────────────────

const drag_type = "application/x-dev-item";

// The move a card dropped on a column asks for: back to an earlier stage, refused forward, or nothing on its own column.
export function drop_move(stage_ids: string[], from: string, to: string): "back" | "forward" | "none" {
  if (from === to) return "none";
  const from_index = from === done ? stage_ids.length : stage_ids.indexOf(from);
  const to_index = to === done ? stage_ids.length : stage_ids.indexOf(to);
  return to_index < from_index ? "back" : "forward";
}

// ── Page ─────────────────────────────────────────────────────────────────────

const all_repositories = "";

const done_column: Stage = { id: done, label: "Done", description: "Items that have been through every stage.", order: 0, next: done, model: "", effort: "", gates: [], max_proposals: 0, paths: [], tools: [], disallowed_tools: [], prompt: "" };

export function BoardView() {
  const { stages: stages_client, runner } = page();
  const [search, set_search] = useState("");
  const [repository, set_repository] = useState(all_repositories);
  const [show_done, set_show_done] = useState(false);
  const [by_repository, set_by_repository] = use_pref("x-dev-board-by-repository", false, (value): value is boolean => typeof value === "boolean");
  const [adding, set_adding] = useState(false);
  const [drop_target, set_drop_target] = useState<string | null>(null);
  const items = use_data((api) => api.list_items(false));
  const runs = use_data((api) => api.list_stage_runs());
  const stages = use_resource(async () => (stages_client ? (await stages_client.list_stages()).stages : []), [stages_client], { watch: data_watch });
  const runner_status = use_resource(async () => (runner ? await runner.get_runner() : null), [runner], { watch: data_watch });
  // Each finished run's changed lines, read again only when the runs shown end or change.
  const finished_ids = (runs.data ?? []).filter((run) => run.state === "done" || run.state === "failed").map((run) => run.run_id);
  const changes = use_resource(async () => (runner && finished_ids.length ? await runner.list_run_changes(finished_ids) : {}), [runner, finished_ids.join(",")]);

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
          options={[[all_repositories, "Every repository"], ...[...new Set((items.data ?? []).map((item) => item.repository))].sort().map((name): [string, string] => [name, name])]}
          value={repository}
          on_change={set_repository}
        />
        <Switch label="Show finished items" show_label checked={show_done} on_change={set_show_done} />
        <Switch label="Group by repository" show_label checked={by_repository} on_change={set_by_repository} />
      </Toolbar>
      <Inbox />
      <Loaded resource={stages}>
        {(stage_list) => {
          if (stage_list.length === 0) return <Empty title="No stages." hint="Add the default stages under Settings → Pipeline → Stages." />;
          const needle = search.trim().toLowerCase();
          const shown = (items.data ?? []).filter(
            (item) =>
              item.stage !== proposed &&
              (show_done || item.stage !== done) &&
              (repository === all_repositories || item.repository === repository) &&
              (!needle || `${item.title} ${item.repository}`.toLowerCase().includes(needle)),
          );
          if (shown.length === 0) return <Empty title="No items on the board." hint={(items.data ?? []).length === 0 ? "Add a feature or bug fix to take it through the stages." : "Nothing matches the filters."} />;
          const columns = show_done ? [...stage_list, done_column] : stage_list;
          const stage_ids = stage_list.map((stage) => stage.id);
          const column_of = (item: Item) => (columns.some((column) => column.id === item.stage) ? item.stage : (stage_list[0]?.id ?? done));
          const lanes = by_repository ? [...new Set(shown.map((item) => item.repository))].sort() : [null];
          const can_run = runner_status.data?.running_run_id == null;
          const runs_of = (item: Item): StageRun[] => (runs.data ?? []).filter((run) => run.item_id === item.id);

          function drop(event: DragEvent<HTMLElement>, column: Stage): void {
            event.preventDefault();
            set_drop_target(null);
            const item = shown.find((each) => each.id === event.dataTransfer.getData(drag_type));
            if (!item) return;
            const move = drop_move(stage_ids, column_of(item), column.id);
            if (move === "back") confirm_send_back(item, column);
            if (move === "forward") toast(`${item.title} moves on only when a run's report sends it; run ${stage_list.find((stage) => stage.id === item.stage)?.label ?? "its stage"} instead.`, { tone: "warn" });
          }

          return (
            <div className="board-scroll">
              <div className="board" aria-label="Board" style={{ gridTemplateColumns: `repeat(${columns.length}, var(--board-column-width))` }}>
                {columns.map((column) => (
                  <div key={column.id} className="board-column-head" title={column.description}>
                    <span className="tile-label">{column.label}</span>
                    <span className="muted small">{shown.filter((item) => column_of(item) === column.id).length}</span>
                  </div>
                ))}
                {lanes.map((lane) => (
                  <Fragment key={lane ?? "all"}>
                    {lane && <h3 className="board-lane-head">{lane}</h3>}
                    {columns.map((column) => {
                      const cards = shown.filter((item) => column_of(item) === column.id && (lane === null || item.repository === lane));
                      const target = `${lane ?? ""} ${column.id}`;
                      return (
                        <section
                          key={column.id}
                          className={cx("board-column", cards.length === 0 && "empty", drop_target === target && "drop-inside")}
                          aria-label={lane ? `${column.label}, ${lane}` : column.label}
                          onDragOver={(event) => {
                            if (!event.dataTransfer.types.includes(drag_type)) return;
                            event.preventDefault();
                            set_drop_target(target);
                          }}
                          onDragLeave={() => set_drop_target((current) => (current === target ? null : current))}
                          onDrop={(event) => drop(event, column)}
                        >
                          <h3 className="board-column-label">
                            <span className="tile-label">{column.label}</span>
                            <span className="muted small">{cards.length}</span>
                          </h3>
                          {cards.map((item) => (
                            <div
                              key={item.id}
                              className="board-card"
                              draggable
                              onDragStart={(event) => {
                                event.dataTransfer.setData(drag_type, item.id);
                                event.dataTransfer.effectAllowed = "move";
                              }}
                            >
                              <ItemCard item={item} stage={stage_list.find((stage) => stage.id === item.stage)} stages={stage_list} runs={runs_of(item)} changes={changes.data ?? {}} can_run={can_run} />
                            </div>
                          ))}
                        </section>
                      );
                    })}
                  </Fragment>
                ))}
              </div>
            </div>
          );
        }}
      </Loaded>
      {adding && <ItemDialog initial={null} on_close={() => set_adding(false)} />}
    </>
  );
}
