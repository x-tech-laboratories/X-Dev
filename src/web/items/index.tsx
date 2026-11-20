// The items: every feature or bug fix X-Dev tracks, with its repository, issue and the stage it is at; the inbox of
// proposals runs made; and a new item, described in free text for an agent to fill in or filled in by hand.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { PathInput, SearchBox, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow, PageHeading, Section, Tabs, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { ComboField } from "@x-tech-laboratories/x-libs/web/react/suggestions";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { format_count } from "@x-tech-laboratories/x-libs/web/format";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { is_repository, issue_link, item_kinds, type Item, type ItemInput, type ItemKind } from "../../shared/items/model.ts";
import type { ItemDraft } from "../../shared/runs/runner.ts";
import { attempt, calls, data_watch, page, succeeds, use_data } from "../api.ts";
import { DialogButtons } from "../forms.tsx";
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
  const { runner, desktop } = page();
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
    if (needs_checkout && checkout.trim()) {
      const added = await attempt(() => runner!.add_repository(checkout.trim()));
      if (added === undefined) return;
      if (added.toLowerCase() !== item.repository.trim().toLowerCase()) return void toast(`That checkout is of ${added}, not ${item.repository.trim()}.`, { tone: "bad" });
      data_watch.bump();
    }
    const id = await attempt(() => calls().save_item(item));
    if (id === undefined) return;
    on_close();
    // An item saved with no issue is linked to a matching open one, or gets one of its own.
    if (!item.issue_number && runner) await link_issue(id);
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
              <PathInput
                label="Checkout"
                placeholder="Its folder on this computer, to add it to Repositories"
                value={checkout}
                on_change={set_checkout}
                pick={async (current) => (desktop ? await desktop.pick_folder(current) : null)}
                browse_label="Choose…"
              />
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
    <Section class_name="inbox-panel" level={3} title={<>Inbox <span className="group-count">{format_count(waiting.length)}</span></>}>
      {waiting.length > 0 && <ul className="inbox">
        {waiting.map((proposal) => (
          <li key={proposal.id}>
            <span className="inbox-text">
              <a href={`#/items/${proposal.id}`}>{proposal.title}</a>
              <span className="muted small"> · {proposal.repository}</span>
              {proposal.body && <span className="muted small"> · {proposal.body}</span>}
            </span>
            <span className="row-actions">
              <button type="button" aria-label={`Take ${proposal.title}`} onClick={() => void succeeds(() => calls().accept_proposal(proposal.id), "Taken into Triage.").then((taken) => (taken ? link_issue(proposal.id) : undefined))}>
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

function ItemsList() {
  const { stages: stages_client } = page();
  const [include_closed, set_include_closed] = useState(false);
  const [search, set_search] = useState("");
  const [editing, set_editing] = useState<Item | "new" | null>(null);
  const items = use_data((api) => api.list_items(include_closed), [include_closed]);
  const stages = use_resource(async () => (stages_client ? (await stages_client.list_stages()).stages : []), [stages_client], { watch: data_watch });

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
    { label: "Stage", cell: (item) => (item.closed_at ? "Closed" : stage_label(stages.data ?? [], item.stage)), sort: (item) => item.stage },
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
      <Inbox />
      <Loaded resource={items}>
        {(list) => {
          const needle = search.trim().toLowerCase();
          const visible = list.filter((item) => item.stage !== "proposed" && (!needle || `${item.title} ${item.repository}`.toLowerCase().includes(needle)));
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

// #/items lists them, #/items/<id> opens one.
export function ItemsView({ parts }: { parts: string[] }) {
  const id = parts[0];
  return id && id !== "list" ? <ItemView key={id} id={decodeURIComponent(id)} run_id={parts[1]} /> : <ItemsList />;
}
