// Settings: the stages, how long history is kept, each feature's own settings, sync with a server on a device, backups,
// and the desktop app's tray and background running.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

import { NumberField, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { BackupSettings } from "@x-tech-laboratories/x-libs/web/react/backup_settings";
import { LocalMcpSettings } from "@x-tech-laboratories/x-libs/web/react/local_mcp_settings";
import { PageHeading, SettingRow, SettingsPage, type SettingsCategory, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { TrustedCertificates } from "@x-tech-laboratories/x-libs/web/react/certificates";
import { SyncSettings } from "@x-tech-laboratories/x-libs/web/react/sync_settings";

import type { DesktopSettings } from "../../shared/desktop.ts";
import { notice_kind_labels, notice_kinds, type NoticeKind } from "../../shared/runs/notices.ts";
import { data_watch, page, set_setting, show_error, use_settings } from "../api.ts";
import { page_features } from "../features.tsx";
import { GitHubSettings, RunSettings } from "../stages/RunnerSettings.tsx";
import { StagesSettings } from "../stages/StagesSettings.tsx";

// ── Stages ───────────────────────────────────────────────────────────────────

// The stages wherever the page reaches their files, and the runner on the desktop, whose daemon runs the agents.
function pipeline_category(): SettingsCategory[] {
  const { stages, runner } = page();
  const sections: SettingsSection[] = [
    ...(stages ? [{ id: "stages", heading: "Stages", hint: "The steps every item goes through, in order, each run by an agent on its own model.", content: <StagesSettings stages_client={stages} /> }] : []),
    ...(runner
      ? [
          { id: "github", heading: "GitHub", hint: "The account issues are found and opened with.", content: <GitHubSettings runner={runner} /> },
          { id: "runs", heading: "Runs", hint: "How this computer runs each stage's agent.", content: <RunSettings runner={runner} /> },
        ]
      : []),
  ];
  return sections.length ? [{ heading: "Pipeline", sections }] : [];
}

// ── History ──────────────────────────────────────────────────────────────────

function history_section(settings: Record<string, unknown>, set_setting: (key: string, value: unknown) => Promise<void>): SettingsSection {
  return {
    id: "history",
    heading: "History",
    hint: "Every change to an item is kept, to look back on or restore under History.",
    content: (
      <SettingRow label="Keep changes for" hint="Older changes are pruned; each item always keeps its latest.">
        <NumberField label="Keep changes for" bare unit="days" min={1} value={Number(settings["history.keep_days"])} on_change={(days) => void set_setting("history.keep_days", days ?? 180)} />
      </SettingRow>
    ),
  };
}

// ── Page ─────────────────────────────────────────────────────────────────────

// A phone's backups wait for a folder it picks; the list is read again once one is, as the folder may already hold some.
function Backups() {
  const { backups, backup_folder } = page();
  const [folder_name, set_folder_name] = useState<string | null>(backup_folder ? null : "");
  useEffect(() => void backup_folder?.get().then(set_folder_name), [backup_folder]);
  if (!backups || folder_name === null) return null;

  const folder_row = backup_folder && (
    <SettingRow label="Backup folder" hint={folder_name || "Pick a folder in the phone's storage, such as Documents, where file managers and sync apps can reach the backups."}>
      <button type="button" onClick={() => void backup_folder.choose().then(set_folder_name)}>
        {folder_name ? "Change" : "Choose"}
      </button>
    </SettingRow>
  );
  return <BackupSettings key={folder_name} device={backups} data_name="X-Dev data" on_restored={() => data_watch.bump()} folder_row={folder_row} can_back_up={!backup_folder || folder_name !== ""} />;
}

// The desktop app's own settings, which belong to this computer and do not sync.
function Desktop() {
  const { desktop } = page();
  const [settings, set_settings] = useState<DesktopSettings | null>(null);
  useEffect(() => void desktop?.get_desktop_settings().then(set_settings, show_error), [desktop]);
  if (!desktop || !settings) return null;

  const change = (key: keyof DesktopSettings, on: boolean): void => {
    set_settings({ ...settings, [key]: on });
    void desktop.set_desktop_setting(key, on).catch(show_error);
  };
  return (
    <>
      <SettingRow label="Show tray icon" hint="An icon in the system tray shows how many items are open and brings the window back." as_label>
        <Switch label="Show tray icon" checked={settings.show_tray_icon} on_change={(on) => change("show_tray_icon", on)} />
      </SettingRow>
      <SettingRow label="Keep running in the background" hint="Sync, backups and the MCP server carry on with the window closed. Turned off, they stop shortly after the last window closes." as_label>
        <Switch label="Keep running in the background" checked={settings.keep_running_in_background} on_change={(on) => change("keep_running_in_background", on)} />
      </SettingRow>
      <SettingRow label="Start at login" hint="Starts X-Dev in the background when you log in, without opening its window." as_label>
        <Switch label="Start at login" checked={settings.start_at_login} disabled={!settings.keep_running_in_background} on_change={(on) => change("start_at_login", on)} />
      </SettingRow>
      <SettingRow label="Quit completely" hint="Closes the window and stops X-Dev in the background too, until you open it again.">
        <button type="button" onClick={() => void desktop.quit_completely().catch(show_error)}>Quit completely</button>
      </SettingRow>
    </>
  );
}

// Which kinds of notification this computer's daemon shows; a browser and a phone show none.
function Notifications() {
  const { desktop } = page();
  const [settings, set_settings] = useState<DesktopSettings | null>(null);
  useEffect(() => void desktop?.get_desktop_settings().then(set_settings, show_error), [desktop]);
  if (!desktop || !settings) return null;

  const key_of = (kind: NoticeKind) => `notify_${kind}` as keyof DesktopSettings;
  const change = (kind: NoticeKind, on: boolean): void => {
    set_settings({ ...settings, [key_of(kind)]: on });
    void desktop.set_desktop_setting(key_of(kind), on).catch(show_error);
  };
  return (
    <>
      {notice_kinds.map((kind) => (
        <SettingRow key={kind} label={notice_kind_labels[kind][0]} hint={notice_kind_labels[kind][1]} as_label>
          <Switch label={notice_kind_labels[kind][0]} checked={settings[key_of(kind)]} on_change={(on) => change(kind, on)} />
        </SettingRow>
      ))}
    </>
  );
}

// Sync on a device with its own database, and backups of whichever database the page works on.
function data_category(): SettingsCategory[] {
  const { device, backups, backup_folder, certificates, local_mcp, desktop } = page();
  const sections: SettingsSection[] = [
    ...(device ? [{ id: "sync", heading: "Sync", hint: "Keep this device's data alike with your X-Dev server.", content: <>
      <SyncSettings device={device} certificates={certificates} subscribe={data_watch.subscribe} data_name="X-Dev data" placeholder="https://dev.example.org/" />
      {certificates && <TrustedCertificates certificates={certificates} />}
    </> }] : []),
    ...(backups
      ? [{ id: "backups", heading: "Backups", hint: backup_folder ? "Copies of this device's data, kept in a folder you pick." : device ? "Copies of this device's data, kept beside it." : "Copies of the server's data, kept in its data folder. A restore restarts the server.", content: <Backups /> }]
      : []),
    ...(desktop ? [{ id: "notifications", heading: "Notifications", hint: "What this computer tells you about runs while X-Dev is closed or out of sight; clicking one opens the item.", content: <Notifications /> }] : []),
    ...(local_mcp
      ? [{ id: "mcp", heading: "MCP server", hint: "Let AI assistants such as Claude Code reach this device's data without the server.", content: <LocalMcpSettings device={local_mcp} name="x-dev" data_name="read and change your items" /> }]
      : []),
    ...(desktop ? [{ id: "desktop", heading: "Desktop", hint: "The tray icon, and what runs while the window is closed.", content: <Desktop /> }] : []),
  ];
  return sections.length ? [{ heading: device ? "This device" : "Server", sections }] : [];
}

export function SettingsView() {
  const settings = use_settings();

  return (
    <>
      <PageHeading title="Settings" />
      <Loaded resource={settings}>
        {(values) => (
          <SettingsPage
            categories={[
              ...pipeline_category(),
              { heading: "General", sections: [history_section(values, set_setting)] },
              ...page_features
                .map((feature) => ({ heading: feature.label, sections: feature.settings({ settings: values, set_setting }) }))
                .filter((category) => category.sections.length > 0),
              ...data_category(),
            ]}
          />
        )}
      </Loaded>
    </>
  );
}
