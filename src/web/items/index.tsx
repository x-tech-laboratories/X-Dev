// The items: every feature or bug fix X-Dev tracks, with its repository, issue and the stage it is at, added and edited
// in a dialog.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { SearchBox, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow, PageHeading, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { is_repository, item_kinds, type Item, type ItemInput, type ItemKind } from "../../shared/items/model.ts";
import { calls, succeeds, use_data } from "../api.ts";
import { DialogButtons } from "../forms.tsx";
import { confirm_delete, row_actions_column } from "../rows.tsx";

// ── Dialog ───────────────────────────────────────────────────────────────────

const kind_labels: Record<ItemKind, string> = { feature: "Feature", bug: "Bug fix" };

function blank_item(): ItemInput {
  return { title: "", kind: "feature", repository: "", issue_number: null };
}

export function ItemDialog({ initial, on_close }: { initial: Item | null; on_close: () => void }) {
  const [item, set_item] = useState<ItemInput>(() => (initial ? { id: initial.id, title: initial.title, kind: initial.kind, repository: initial.repository, issue_number: initial.issue_number } : blank_item()));
  const change = (changes: Partial<ItemInput>) => set_item((current) => ({ ...current, ...changes }));

  async function save(): Promise<void> {
    if (!item.title.trim()) return void toast("An item needs a title.", { tone: "bad" });
    if (!is_repository(item.repository.trim())) return void toast("Name the repository as owner/name.", { tone: "bad" });
    if (await succeeds(() => calls().save_item(item))) on_close();
  }

  return (
    <Dialog title={initial ? `Edit ${initial.title}` : "Add Item"} on_close={on_close} buttons={<DialogButtons on_save={() => void save()} on_cancel={on_close} />}>
      <div className="form-rows">
        <FormRow label="Title" id="item-title">
          <input id="item-title" type="text" value={item.title} onChange={(event) => change({ title: event.currentTarget.value })} />
        </FormRow>
        <FormRow label="Kind" id="item-kind">
          <Select<ItemKind> label="Kind" bare options={item_kinds.map((kind) => [kind, kind_labels[kind]])} value={item.kind ?? "feature"} on_change={(kind) => change({ kind })} />
        </FormRow>
        <FormRow label="Repository" id="item-repository">
          <input id="item-repository" type="text" placeholder="owner/name" value={item.repository} onChange={(event) => change({ repository: event.currentTarget.value })} />
        </FormRow>
        <FormRow label="Issue" id="item-issue">
          <input
            id="item-issue"
            type="number"
            min={1}
            value={item.issue_number ?? ""}
            onChange={(event) => change({ issue_number: event.currentTarget.value ? Number(event.currentTarget.value) : null })}
          />
        </FormRow>
      </div>
    </Dialog>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────

export function issue_link(item: Item): string | null {
  return item.issue_number === null ? null : `https://github.com/${item.repository}/issues/${item.issue_number}`;
}

export function ItemsView() {
  const [include_closed, set_include_closed] = useState(false);
  const [search, set_search] = useState("");
  const [editing, set_editing] = useState<Item | "new" | null>(null);
  const items = use_data((api) => api.list_items(include_closed), [include_closed]);

  function remove(item: Item): void {
    confirm_delete(`Delete ${item.title}?`, "It can be brought back from its history.", () => succeeds(() => calls().delete_item(item.id)));
  }

  const columns: TableColumn<Item>[] = [
    { label: "Title", cell: (item) => item.title, sort: (item) => item.title.toLowerCase() },
    { label: "Kind", cell: (item) => kind_labels[item.kind] },
    { label: "Repository", cell: (item) => item.repository, sort: (item) => item.repository.toLowerCase() },
    {
      label: "Issue",
      cell: (item) => {
        const link = issue_link(item);
        return link ? <a href={link} target="_blank" rel="noreferrer">#{item.issue_number}</a> : "—";
      },
    },
    { label: "Stage", cell: (item) => (item.closed_at ? "Closed" : item.stage), sort: (item) => item.stage },
    row_actions_column<Item>({
      name: (item) => item.title,
      edit: set_editing,
      history: (item) => ({ kind: "item", item_id: item.id }),
      trailing: (item) => (
        <button type="button" aria-label={`${item.closed_at ? "Reopen" : "Close"} ${item.title}`} onClick={() => void succeeds(() => (item.closed_at ? calls().reopen_item(item.id) : calls().close_item(item.id)))}>
          {item.closed_at ? "Reopen" : "Close"}
        </button>
      ),
      remove,
    }),
  ];

  return (
    <>
      <PageHeading title="Items" />
      <Toolbar>
        <button type="button" className="accent solid" onClick={() => set_editing("new")}>
          Add Item
        </button>
        <SearchBox label="Search items" value={search} on_input={set_search} />
        <Switch label="Show closed items" show_label checked={include_closed} on_change={set_include_closed} />
      </Toolbar>
      <Loaded resource={items}>
        {(list) => {
          const needle = search.trim().toLowerCase();
          const visible = list.filter((item) => !needle || `${item.title} ${item.repository}`.toLowerCase().includes(needle));
          return visible.length === 0 ? (
            <Empty title="No items." hint={list.length === 0 ? "Add a feature or bug fix to take it through the stages." : "Nothing matches the search."} />
          ) : (
            <DataTable columns={columns} rows={visible} row_key={(item) => item.id} />
          );
        }}
      </Loaded>
      {editing && <ItemDialog key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} on_close={() => set_editing(null)} />}
    </>
  );
}
