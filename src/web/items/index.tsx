// The items page: every feature or bug fix X-Dev tracks, as a board of stages or as a list, under one toolbar and the
// inbox of proposals runs made; and a new item, described in free text for an agent to fill in or filled in by hand.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { SearchBox, Segmented, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow, PageHeading, Section, Tabs, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { is_boolean, one_of } from "@x-tech-laboratories/x-libs/web/prefs";
import { use_pref } from "@x-tech-laboratories/x-libs/web/react/prefs";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { ComboField } from "@x-tech-laboratories/x-libs/web/react/suggestions";
import { DataTable, type RowGroup, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { format_count } from "@x-tech-laboratories/x-libs/web/format";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { is_repository, issue_link, item_kinds, proposed, type Item, type ItemInput, type ItemKind } from "../../shared/items/model.ts";
import type { AddedItem, ItemDraft } from "../../shared/runs/runner.ts";
import { done, type Stage } from "../../shared/stages/model.ts";
import { attempt, calls, data_watch, page, succeeds, use_data } from "../api.ts";
import { ItemsBoard } from "../board/index.tsx";
import { DialogButtons, FolderField } from "../forms.tsx";
import { confirm_delete, row_actions_column } from "../rows.tsx";
import { ItemView, stage_label } from "./ItemView.tsx";

// ── Dialog ───────────────────────────────────────────────────────────────────

const kind_labels: Record<ItemKind, string> = { feature: "Feature", bug: "Bug fix" };

function blank_item(): ItemInput {
  return { title: "", kind: "feature", repository: "", issue_number: null, body: "" };
}

function input_of(item: Item): ItemInput {
  return { id: item.id, title: item.title, kind: item.kind, repository: item.repository, issue_number: item.issue_number, body: item.body };
}

type Way = "describe" | "form";

// The free text an agent turns into a draft, which then opens in the form for the user to check.
function DescribePane({ on_draft }: { on_draft: (draft: ItemDraft) => void }) {
  const { runner } = page();
  const [text, set_text] = useState("");
  const [busy, set_busy] = useState(false);
  async function describe(): Promise<void> {
    set_busy(true);
    const draft = await attempt(() => runner!.describe_item(text));
    set_busy(false);
    if (draft) on_draft(draft);
  }
  return (
    <>
      <textarea aria-label="Describe it" rows={8} placeholder="Paste a bug report or write a few lines about the feature" value={text} onChange={(event) => set_text(event.currentTarget.value)} />
      <Toolbar>
        <button type="button" className="accent solid" disabled={busy || !text.trim()} onClick={() => void describe()}>
          {busy ? "Drafting…" : "Draft the Item"}
        </button>
      </Toolbar>
    </>
  );
}

export function ItemDialog({ initial, on_close }: { initial: Item | null; on_close: () => void }) {
  const { runner, desktop, daemon_is_here } = page();
  const folder_picker = desktop && daemon_is_here ? (current: string) => desktop.pick_folder(current) : undefined;
  const [way, set_way] = useState<Way>(initial || !runner ? "form" : "describe");
  const [item, set_item] = useState<ItemInput>(() => (initial ? input_of(initial) : blank_item()));
  const [checkout, set_checkout] = useState("");
  const repositories = use_resource(async () => (runner ? Object.keys((await runner.get_runner()).settings.repositories) : []), [runner]);
  // A repository with no known checkout can be given one here, which is added to Repositories on saving.
  const needs_checkout = Boolean(runner) && !initial && is_repository(item.repository.trim()) && repositories.data != null && !repositories.data.includes(item.repository.trim());
  const change = (changes: Partial<ItemInput>) => set_item((current) => ({ ...current, ...changes }));

  async function save(): Promise<void> {
    if (!item.title.trim()) return void toast("An item needs a title.", { tone: "bad" });
    if (!is_repository(item.repository.trim())) return void toast("Name the repository as owner/name.", { tone: "bad" });
    // Where agents run, the daemon adds the checkout, saves the item and links or opens its issue in one call, as MCP does.
    if (runner && !initial) {
      const added = await attempt(() => runner.add_item({ ...item, ...(needs_checkout && checkout.trim() ? { checkout: checkout.trim() } : {}) }));
      if (added === undefined) return;
      data_watch.bump();
      on_close();
      return void tell_issue(added);
    }
    if (await attempt(() => calls().save_item(item)) !== undefined) on_close();
  }

  return (
    <Dialog title={initial ? `Edit ${initial.title}` : "Add Item"} wide on_close={on_close} buttons={way === "form" ? <DialogButtons on_save={() => void save()} on_cancel={on_close} /> : undefined}>
      {!initial && runner && (
        <Tabs<Way>
          label="How to add it"
          items={[
            { id: "describe", label: "Describe It" },
            { id: "form", label: "Fill In the Form" },
          ]}
          active={way}
          on_select={set_way}
        />
      )}
      {way === "describe" ? (
        <DescribePane
          on_draft={({ checkout: found, ...draft }) => {
            set_item({ ...draft, issue_number: null });
            set_checkout(found ?? "");
            set_way("form");
          }}
        />
      ) : (
        <div className="form-rows">
          <FormRow label="Title" id="item-title">
            <input id="item-title" type="text" value={item.title} onChange={(event) => change({ title: event.currentTarget.value })} />
          </FormRow>
          <FormRow label="Kind" id="item-kind">
            <Select<ItemKind> label="Kind" bare options={item_kinds.map((kind) => [kind, kind_labels[kind]])} value={item.kind ?? "feature"} on_change={(kind) => change({ kind })} />
          </FormRow>
          <FormRow label="Repository" id="item-repository">
            <ComboField id="item-repository" label="Repository" placeholder="owner/name" value={item.repository} options={repositories.data ?? []} list_on_focus on_change={(repository) => change({ repository })} />
          </FormRow>
          {needs_checkout && (
            <FormRow label="Checkout" id="item-checkout">
              <FolderField label="Checkout" placeholder="Its folder on the computer that runs the agents, to add it to Repositories" value={checkout} on_change={set_checkout} pick={folder_picker} />
            </FormRow>
          )}
          <FormRow label="Issue" id="item-issue">
            <input
              id="item-issue"
              type="number"
              min={1}
              placeholder={runner ? "Found or opened when left blank" : "None yet"}
              value={item.issue_number ?? ""}
              onChange={(event) => change({ issue_number: event.currentTarget.value ? Number(event.currentTarget.value) : null })}
            />
          </FormRow>
          <FormRow label="What it asks for" id="item-body">
            <textarea id="item-body" rows={6} value={item.body ?? ""} onChange={(event) => change({ body: event.currentTarget.value })} />
          </FormRow>
        </div>
      )}
    </Dialog>
  );
}

// ── Issues ───────────────────────────────────────────────────────────────────

// Says which issue an added or taken item was linked to or opened, or why none could be.
function tell_issue(added: AddedItem): void {
  if (added.problem) toast(`Saved, but its issue could not be found or opened: ${added.problem}`, { tone: "bad" });
  else if (added.issue) toast(added.issue.opened ? `Opened issue #${added.issue.number}.` : `Linked to the open issue #${added.issue.number}.`, { tone: "good" });
}

// Takes a proposal into Triage, linking or opening its issue where the daemon reaches GitHub.
async function take_proposal(id: string): Promise<void> {
  const { runner } = page();
  if (!runner) return void (await succeeds(() => calls().accept_proposal(id), "Taken into Triage."));
  const taken = await attempt(() => runner.take_proposal(id), "Taken into Triage.");
  if (!taken) return;
  data_watch.bump();
  tell_issue(taken);
}

// Links an item to a matching open issue, or opens one, saying which.
export async function link_issue(item_id: string): Promise<void> {
  const { runner } = page();
  if (!runner) return;
  const link = await attempt(() => runner.link_issue(item_id));
  if (!link) return;
  data_watch.bump();
  toast(link.opened ? `Opened issue #${link.number}.` : `Linked to the open issue #${link.number}.`, { tone: "good" });
}

// ── Inbox ────────────────────────────────────────────────────────────────────

// The proposals waiting for the user, one line each; with none it is just its heading.
export function Inbox() {
  const proposals = use_data((api) => api.list_proposals());
  const waiting = proposals.data ?? [];
  return (
    <Section class_name="inbox-panel compact" level={3} title={<>Inbox <span className="group-count">{format_count(waiting.length)}</span></>}>
      {waiting.length > 0 && <ul className="inbox">
        {waiting.map((proposal) => (
          <li key={proposal.id}>
            <span className="inbox-text">
              <a href={`#/items/${proposal.id}`}>{proposal.title}</a>
              <span className="muted small"> · {proposal.repository}</span>
              {proposal.body && <span className="muted small"> · {proposal.body}</span>}
            </span>
            <span className="row-actions">
              <button type="button" aria-label={`Take ${proposal.title}`} onClick={() => void take_proposal(proposal.id)}>
                Take
              </button>
              <button type="button" aria-label={`Drop ${proposal.title}`} onClick={() => void succeeds(() => calls().drop_proposal(proposal.id))}>
                Drop
              </button>
            </span>
          </li>
        ))}
      </ul>}
    </Section>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────

interface ItemsListProps {
  items: Item[];
  has_items: boolean;
  stages: Stage[];
  by_repository: boolean;
  on_edit: (item: Item) => void;
}

// The list view of the items page: a table of the items, under a heading per repository when grouped.
function ItemsList({ items, has_items, stages, by_repository, on_edit }: ItemsListProps) {
  function remove(item: Item): void {
    confirm_delete(`Delete ${item.title}?`, "It can be brought back from its history.", () => succeeds(() => calls().delete_item(item.id)));
  }

  const columns: TableColumn<Item>[] = [
    { label: "Title", cell: (item) => <a href={`#/items/${item.id}`}>{item.title}</a>, sort: (item) => item.title.toLowerCase() },
    { label: "Kind", cell: (item) => kind_labels[item.kind] },
    { label: "Repository", cell: (item) => item.repository, sort: (item) => item.repository.toLowerCase() },
    {
      label: "Issue",
      cell: (item) => {
        const link = issue_link(item);
        return link ? (
          <a href={link} target="_blank" rel="noreferrer">
            #{item.issue_number}
          </a>
        ) : (
          "—"
        );
      },
    },
    { label: "Stage", cell: (item) => (item.closed_at ? "Closed" : stage_label(stages, item.stage)), sort: (item) => item.stage },
    row_actions_column<Item>({
      name: (item) => item.title,
      edit: on_edit,
      history: (item) => ({ kind: "item", item_id: item.id }),
      trailing: (item) => (
        <button type="button" aria-label={`${item.closed_at ? "Reopen" : "Close"} ${item.title}`} onClick={() => void succeeds(() => (item.closed_at ? calls().reopen_item(item.id) : calls().close_item(item.id)))}>
          {item.closed_at ? "Reopen" : "Close"}
        </button>
      ),
      remove,
    }),
  ];

  if (items.length === 0) return <Empty title="No items." hint={has_items ? "Nothing matches the filters." : "Add a feature or bug fix to take it through the stages."} />;
  const groups: RowGroup<Item>[] | undefined = by_repository
    ? [...new Set(items.map((item) => item.repository))].sort().map((name) => {
        const rows = items.filter((item) => item.repository === name);
        return { key: name, label: <>{name} <span className="group-count">{format_count(rows.length)}</span></>, rows };
      })
    : undefined;
  return <DataTable columns={columns} rows={items} groups={groups} row_key={(item) => item.id} />;
}

// ── Page ─────────────────────────────────────────────────────────────────────

const items_layouts = ["board", "list"] as const;

export type ItemsLayout = (typeof items_layouts)[number];

const layout_choices: { value: ItemsLayout; label: string }[] = [
  { value: "board", label: "Board" },
  { value: "list", label: "List" },
];

export function is_items_layout(text: string | undefined): text is ItemsLayout {
  return items_layouts.some((layout) => layout === text);
}

const all_repositories = "";

// One toolbar, inbox and set of filters over either the board or the list, the choice of which is kept on this device.
function ItemsPage({ named_layout }: { named_layout: ItemsLayout | undefined }) {
  const { stages: stages_client } = page();
  const [saved_layout, set_saved_layout] = use_pref<ItemsLayout>("x-dev-items-layout", "board", one_of(...items_layouts));
  const [search, set_search] = useState("");
  const [repository, set_repository] = useState(all_repositories);
  const [show_finished, set_show_finished] = useState(false);
  const [by_repository, set_by_repository] = use_pref("x-dev-board-by-repository", false, is_boolean);
  const [editing, set_editing] = useState<Item | "new" | null>(null);
  const items = use_data((api) => api.list_items(show_finished), [show_finished]);
  const stages = use_resource(async () => (stages_client ? (await stages_client.list_stages()).stages : []), [stages_client], { watch: data_watch });

  const layout = named_layout ?? saved_layout;
  const kept = (items.data ?? []).filter((item) => item.stage !== proposed);
  const needle = search.trim().toLowerCase();
  const shown = kept.filter(
    (item) =>
      (show_finished || item.stage !== done) &&
      (repository === all_repositories || item.repository === repository) &&
      (!needle || `${item.title} ${item.repository}`.toLowerCase().includes(needle)),
  );
  const repositories = [...new Set((items.data ?? []).map((item) => item.repository))].sort();

  function pick_layout(next: ItemsLayout): void {
    set_saved_layout(next);
    window.location.hash = `/items/${next}`;
  }

  return (
    <>
      <PageHeading title="Items" />
      <Toolbar>
        <button type="button" className="accent solid" onClick={() => set_editing("new")}>
          Add Item
        </button>
        <SearchBox label="Search items" value={search} on_input={set_search} />
        <Select<string> label="Repository" bare options={[[all_repositories, "Every repository"], ...repositories.map((name): [string, string] => [name, name])]} value={repository} on_change={set_repository} />
        <Switch label="Show finished items" show_label checked={show_finished} on_change={set_show_finished} />
        <Switch label="Group by repository" show_label checked={by_repository} on_change={set_by_repository} />
        <Segmented<ItemsLayout> label="Layout" choices={layout_choices} value={layout} on_change={pick_layout} />
      </Toolbar>
      <Inbox />
      {layout === "board" ? (
        <ItemsBoard
          items={shown}
          has_items={kept.length > 0}
          stages={stages.data ?? []}
          show_done={show_finished}
          by_repository={by_repository}
          loading={stages.loading || items.loading}
          error={stages.error ?? items.error ?? undefined}
          on_retry={() => void Promise.all([stages.reload(), items.reload()])}
        />
      ) : (
        <Loaded resource={items}>
          {() => <ItemsList items={shown} has_items={kept.length > 0} stages={stages.data ?? []} by_repository={by_repository} on_edit={set_editing} />}
        </Loaded>
      )}
      {editing && <ItemDialog key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} on_close={() => set_editing(null)} />}
    </>
  );
}

// #/items shows the board or the list as last picked, #/items/board and #/items/list name one, #/items/<id> opens an item.
export function ItemsView({ parts }: { parts: string[] }) {
  const [id, run_id] = parts;
  if (!id || is_items_layout(id)) return <ItemsPage named_layout={is_items_layout(id) ? id : undefined} />;
  return <ItemView key={id} id={decodeURIComponent(id)} run_id={run_id} />;
}
