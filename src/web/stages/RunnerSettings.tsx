// The runner's settings, which belong to the computer that runs the agents: where each repository's checkout is, how
// the agents' actions are approved, the claude program, and the model that fills in a described item.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { CommitInput, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { SettingRow, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";

import { permission_modes, type PermissionMode, type RunnerMethods } from "../../shared/runs/runner.ts";
import { model_suggestions } from "../../shared/stages/model.ts";
import { data_watch, succeeds } from "../api.ts";

// ── Repositories ─────────────────────────────────────────────────────────────

export function RepositoriesSettings({ runner }: { runner: Client<RunnerMethods> }) {
  const status = use_resource(() => runner.get_runner(), [runner], { watch: data_watch });
  const [repository, set_repository] = useState("");
  const [folder, set_folder] = useState("");

  async function add(): Promise<void> {
    if (await succeeds(() => runner.set_repository(repository.trim(), folder.trim()))) {
      set_repository("");
      set_folder("");
      data_watch.bump();
    }
  }

  return (
    <Loaded resource={status}>
      {({ settings }) => {
        const rows = Object.entries(settings.repositories).map(([name, path]) => ({ name, path }));
        return (
          <>
            {rows.length > 0 && (
              <DataTable
                columns={[
                  { label: "Repository", cell: (row) => row.name },
                  { label: "Checkout", cell: (row) => <code>{row.path}</code> },
                  {
                    label: "Actions",
                    id: "actions",
                    header: <span className="visually-hidden">Actions</span>,
                    cell: (row) => (
                      <button type="button" className="danger" aria-label={`Remove ${row.name}`} onClick={() => void succeeds(() => runner.remove_repository(row.name)).then(() => data_watch.bump())}>
                        Remove
                      </button>
                    ),
                  },
                ]}
                rows={rows}
                row_key={(row) => row.name}
              />
            )}
            <Toolbar>
              <input type="text" aria-label="Repository" placeholder="owner/name" value={repository} onChange={(event) => set_repository(event.currentTarget.value)} />
              <input type="text" aria-label="Checkout folder" placeholder="/path/to/its/checkout" value={folder} onChange={(event) => set_folder(event.currentTarget.value)} />
              <button type="button" disabled={!repository.trim() || !folder.trim()} onClick={() => void add()}>
                Add Repository
              </button>
            </Toolbar>
          </>
        );
      }}
    </Loaded>
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────

const mode_labels: Record<PermissionMode, string> = {
  auto: "Auto: each action is checked",
  acceptEdits: "Accept edits, refuse the rest",
  dontAsk: "Refuse anything not allowed",
  bypassPermissions: "Allow everything",
};

export function RunSettings({ runner }: { runner: Client<RunnerMethods> }) {
  const status = use_resource(() => runner.get_runner(), [runner], { watch: data_watch });
  const set = (key: "permission_mode" | "claude_program" | "describer_model" | "gh_program", value: string) => void succeeds(() => runner.set_runner_setting(key, value as never)).then(() => data_watch.bump());

  return (
    <Loaded resource={status}>
      {({ settings }) => (
        <>
          <SettingRow label="Permissions" hint="How an agent's actions are approved while no one watches.">
            <Select<PermissionMode> label="Permissions" bare options={permission_modes.map((mode) => [mode, mode_labels[mode]])} value={settings.permission_mode} on_change={(mode) => set("permission_mode", mode)} />
          </SettingRow>
          <SettingRow label="Claude program" hint="The claude command, found on the PATH unless a full path is given.">
            <CommitInput aria-label="Claude program" value={settings.claude_program} on_commit={(event) => set("claude_program", event.currentTarget.value)} />
          </SettingRow>
          <SettingRow label="GitHub program" hint="The gh command, signed into GitHub, through which issues are found and opened; X-Dev never holds a token.">
            <CommitInput aria-label="GitHub program" value={settings.gh_program} on_commit={(event) => set("gh_program", event.currentTarget.value)} />
          </SettingRow>
          <SettingRow label="Describing model" hint="The model that fills in the form from a description; a small one is enough.">
            <CommitInput aria-label="Describing model" list="describing-models" value={settings.describer_model} on_commit={(event) => set("describer_model", event.currentTarget.value)} />
            <datalist id="describing-models">
              {model_suggestions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </SettingRow>
        </>
      )}
    </Loaded>
  );
}
