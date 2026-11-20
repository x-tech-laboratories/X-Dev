// The repositories X-Dev works on: each with the folder its checkout is in on this computer and its open items, added
// by picking a checkout's folder, whose owner/name is read from its git remote.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { PathInput } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { attempt, data_watch, page, succeeds, use_data } from "../api.ts";
import { confirm_delete } from "../rows.tsx";

// ── Page ─────────────────────────────────────────────────────────────────────

interface RepositoryRow {
  name: string;
  folder: string;
  open_items: number;
}

export function RepositoriesView() {
  const { runner, desktop } = page();
  const [folder, set_folder] = useState("");
  const status = use_resource(async () => (runner ? await runner.get_runner() : null), [runner], { watch: data_watch });
  const items = use_data((api) => api.list_items(false));

  if (!runner) {
    return (
      <>
        <PageHeading title="Repositories" />
        <p className="muted">Repositories are kept by the desktop app, whose background process holds their checkouts and runs the agents.</p>
      </>
    );
  }

  async function add(): Promise<void> {
    const name = await attempt(() => runner!.add_repository(folder));
    if (name === undefined) return;
    set_folder("");
    data_watch.bump();
    toast(`Added ${name}.`, { tone: "good" });
  }

  function remove(row: RepositoryRow): void {
    confirm_delete(`Forget ${row.name}?`, "X-Dev stops running stages in its checkout; the checkout, its worktrees and its items stay as they are.", () =>
      succeeds(() => runner!.remove_repository(row.name)).then(() => data_watch.bump()),
    );
  }

  const columns: TableColumn<RepositoryRow>[] = [
    {
      label: "Repository",
      cell: (row) => (
        <a href={`https://github.com/${row.name}`} target="_blank" rel="noreferrer">
          {row.name}
        </a>
      ),
      sort: (row) => row.name.toLowerCase(),
    },
    { label: "Checkout", cell: (row) => <code>{row.folder}</code> },
    { label: "Open items", cell: (row) => String(row.open_items), sort: (row) => row.open_items },
    {
      label: "Actions",
      id: "actions",
      header: <span className="visually-hidden">Actions</span>,
      class: "actions-cell",
      cell: (row) => (
        <button type="button" className="danger" aria-label={`Forget ${row.name}`} onClick={() => remove(row)}>
          Forget
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeading title="Repositories" subtitle="Each repository's checkout on this computer; an item's runs work in a worktree of it." />
      <Toolbar>
        <PathInput
          label="Checkout folder"
          placeholder="/path/to/a/checkout"
          value={folder}
          on_change={set_folder}
          pick={async (current) => (desktop ? await desktop.pick_folder(current) : null)}
          browse_label="Choose…"
        />
        <button type="button" className="accent solid" disabled={!folder.trim()} onClick={() => void add()}>
          Add Repository
        </button>
      </Toolbar>
      <Loaded resource={status}>
        {(found) => {
          const rows = Object.entries(found?.settings.repositories ?? {}).map(([name, path]) => ({
            name,
            folder: path,
            open_items: (items.data ?? []).filter((item) => item.repository === name).length,
          }));
          return rows.length === 0 ? (
            <Empty title="No repositories." hint="Choose a checkout's folder; its owner and name are read from its git remote." />
          ) : (
            <DataTable columns={columns} rows={rows} row_key={(row) => row.name} />
          );
        }}
      </Loaded>
    </>
  );
}
