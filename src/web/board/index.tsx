// The board: a swimlane for each open item and a column for each stage, each cell showing that stage's latest run on
// the item, the current stage marked with its Run button, lanes grouped by repository, and the inbox above them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Fragment, useState } from "react";
import { StateBadge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { SearchBox, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { cx } from "@x-tech-laboratories/x-libs/web/dom";

import { proposed, type Item } from "../../shared/items/model.ts";
import type { StageRun } from "../../shared/runs/model.ts";
import { done, type Stage } from "../../shared/stages/model.ts";
import { data_watch, page, succeeds, use_data } from "../api.ts";
import { Inbox, ItemDialog } from "../items/index.tsx";
import { run_state_labels } from "../items/ItemView.tsx";

// ── Cells ────────────────────────────────────────────────────────────────────

interface CellProps {
  item: Item;
  stage: Stage;
  run: StageRun | undefined;
  is_current: boolean;
  is_passed: boolean;
  can_run: boolean;
}

function Cell({ item, stage, run, is_current, is_passed, can_run }: CellProps) {
  const { runner } = page();
  const link = `#/items/${item.id}`;
  return (
    <div className={cx("board-cell", is_current && "current", !run && !is_current && "empty")} role="cell" aria-label={`${item.title}, ${stage.label}`}>
      {run && (
        <a href={link} className="board-run" title={run.error || run.summary}>
          <StateBadge labels={run_state_labels} state={run.state} />
          {run.summary && <span className="board-summary small">{run.summary}</span>}
        </a>
      )}
      {!run && is_passed && <span className="muted small">Skipped</span>}
      {is_current && runner && can_run && (!run || (run.state !== "running" && run.state !== "waiting")) && (
        <button type="button" className="accent solid" aria-label={`Run ${stage.label} on ${item.title}`} onClick={() => void succeeds(() => runner.start_run(item.id, {})).then(() => data_watch.bump())}>
          Run
        </button>
      )}
    </div>
  );
}

// ── Lanes ────────────────────────────────────────────────────────────────────

function Lane({ item, stages, runs, can_run }: { item: Item; stages: Stage[]; runs: StageRun[]; can_run: boolean }) {
  const current_index = item.stage === done ? stages.length : stages.findIndex((stage) => stage.id === item.stage);
  return (
    <div className="board-lane" role="row">
      <div className="board-head" role="rowheader">
        <a href={`#/items/${item.id}`}>{item.title}</a>
        <span className="muted small">
          {item.kind === "bug" ? "Bug fix" : "Feature"}
          {item.issue_number !== null && (
            <>
              {" · "}
              <a href={`https://github.com/${item.repository}/issues/${item.issue_number}`} target="_blank" rel="noreferrer">
                #{item.issue_number}
              </a>
            </>
          )}
        </span>
      </div>
      {stages.map((stage, index) => (
        <Cell
          key={stage.id}
          item={item}
          stage={stage}
          run={runs.find((run) => run.stage === stage.id)}
          is_current={index === current_index}
          is_passed={current_index >= 0 && index < current_index}
          can_run={can_run}
        />
      ))}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const all_repositories = "";

export function BoardView() {
  const { stages: stages_client, runner } = page();
  const [search, set_search] = useState("");
  const [repository, set_repository] = useState(all_repositories);
  const [show_done, set_show_done] = useState(false);
  const [adding, set_adding] = useState(false);
  const items = use_data((api) => api.list_items(false));
  const runs = use_data((api) => api.list_stage_runs());
  const stages = use_resource(async () => (stages_client ? (await stages_client.list_stages()).stages : []), [stages_client], { watch: data_watch });
  const runner_status = use_resource(async () => (runner ? await runner.get_runner() : null), [runner], { watch: data_watch });

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
          const groups = [...new Set(shown.map((item) => item.repository))].sort();
          const can_run = runner_status.data?.running_run_id == null;
          return (
            <div className="board-scroll">
              <div className="board" role="table" aria-label="Board" style={{ gridTemplateColumns: `minmax(12rem, 1.4fr) repeat(${stage_list.length}, minmax(8rem, 1fr))` }}>
                <div className="board-lane board-columns" role="row">
                  <div className="board-head" role="columnheader">
                    Item
                  </div>
                  {stage_list.map((stage) => (
                    <div key={stage.id} className="board-column" role="columnheader" title={stage.description}>
                      {stage.label}
                    </div>
                  ))}
                </div>
                {groups.map((group) => (
                  <Fragment key={group}>
                    <div className="board-group" role="row">
                      <div role="cell">{group}</div>
                    </div>
                    {shown
                      .filter((item) => item.repository === group)
                      .map((item) => (
                        <Lane key={item.id} item={item} stages={stage_list} runs={(runs.data ?? []).filter((run) => run.item_id === item.id)} can_run={can_run} />
                      ))}
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
