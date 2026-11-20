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
import { ConnectionSettings } from "@x-tech-laboratories/x-libs/web/react/connections";
import { SyncSettings } from "@x-tech-laboratories/x-libs/web/react/sync_settings";

import type { DesktopSettings } from "../../shared/desktop.ts";
import { notice_kind_labels, notice_kinds, type NoticeKind } from "../../shared/runs/notices.ts";
import { data_watch, page, set_setting, show_error, use_settings } from "../api.ts";
import { page_features } from "../features.tsx";
import { GitHubSettings, RunSettings } from "../stages/RunnerSettings.tsx";
import { RemoteAccessSettings } from "./RemoteAccessSettings.tsx";
import { StagesSettings } from "../stages/StagesSettings.tsx";
import { WebhookSettings } from "../webhooks/WebhookSettings.tsx";

// ── Stages ───────────────────────────────────────────────────────────────────

// The stages wherever the page reaches their files, and the runner wherever the daemon runs the agents.
function pipeline_category(): SettingsCategory[] {
  const { stages, runner, github_webhook } = page();
  const sections: SettingsSection[] = [
    ...(stages ? [{ id: "stages", heading: "Stages", hint: "The steps every item goes through, in order, each run by an agent on its own model.", content: <StagesSettings stages_client={stages} /> }] : []),
    ...(runner
      ? [
          { id: "github", heading: "GitHub", hint: "The account issues are found and opened with.", content: <GitHubSettings runner={runner} /> },
          ...webhook_section(),
          { id: "runs", heading: "Runs", hint: page().daemon_is_here ? "How this computer runs each stage's agent." : "How the computer that holds the checkouts runs each stage's agent.", content: <RunSettings runner={runner} is_here={page().daemon_is_here === true} /> },
        ]
      : webhook_section()),
  ];
  return sections.length ? [{ heading: "Pipeline", sections }] : [];

  // GitHub's webhooks wherever the host takes them and the user is an admin, with or without a runner.
  function webhook_section(): SettingsSection[] {
    return github_webhook ? [{ id: "webhooks", heading: "Webhooks", hint: "Let GitHub tell X-Dev at once when a pull request, its checks or an issue change, instead of waiting for the next poll.", content: <WebhookSettings webhooks={github_webhook} runner={runner} /> }] : [];
  }
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

function Backups() {
  const { backups } = page();
  if (!backups) return null;
  return <BackupSettings device={backups} data_name="X-Dev data" on_restored={() => data_watch.bump()} />;
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

// Which kinds of notification this device shows: the desktop's kept with its other settings, a phone's on the phone.
function Notifications() {
  const { desktop, notice_kinds: phone_kinds } = page();
  const [kinds, set_kinds] = useState<Record<NoticeKind, boolean> | null>(null);
  const key_of = (kind: NoticeKind) => `notify_${kind}` as keyof DesktopSettings;
  useEffect(() => {
    if (phone_kinds) void phone_kinds.get().then(set_kinds, show_error);
    else if (desktop) void desktop.get_desktop_settings().then((settings) => set_kinds(Object.fromEntries(notice_kinds.map((kind) => [kind, settings[key_of(kind)]])) as Record<NoticeKind, boolean>), show_error);
  }, [desktop, phone_kinds]);
  if (!kinds) return null;

  const change = (kind: NoticeKind, on: boolean): void => {
    set_kinds({ ...kinds, [kind]: on });
    const saved = phone_kinds ? phone_kinds.set(kind, on) : desktop!.set_desktop_setting(key_of(kind), on);
    void saved.catch(show_error);
  };
  return (
    <>
      {notice_kinds.map((kind) => (
        <SettingRow key={kind} label={notice_kind_labels[kind][0]} hint={notice_kind_labels[kind][1]} as_label>
          <Switch label={notice_kind_labels[kind][0]} checked={kinds[kind]} on_change={(on) => change(kind, on)} />
        </SettingRow>
      ))}
    </>
  );
}

// Sync on a device with its own database, and backups of whichever database the page works on.
function data_category(): SettingsCategory[] {
  const { host, device, backups, certificates, local_mcp, desktop, connections, remote_access, notice_kinds: phone_kinds } = page();
  const sections: SettingsSection[] = [
    ...(connections
      ? [{ id: "connections", heading: "Connections", hint: host === "android" ? "The X-Dev daemon this phone works on: the computer that holds the checkouts and runs the agents." : "The X-Dev daemon this window works on: This computer, or another computer that lets other devices connect.", content: <>
        <ConnectionSettings client={connections} certificates={certificates} placeholder="https://dev.example.org:7760" />
        {!device && certificates && <TrustedCertificates certificates={certificates} />}
      </> }]
      : []),
    ...(remote_access ? [{ id: "remote", heading: "Other devices", hint: "Let phones, browsers and other computers work on this computer's X-Dev.", content: <RemoteAccessSettings remote={remote_access} /> }] : []),
    ...(device ? [{ id: "sync", heading: "Sync", hint: "Keep this device's data alike with your X-Dev server.", content: <>
      <SyncSettings device={device} certificates={certificates} subscribe={data_watch.subscribe} data_name="X-Dev data" placeholder="https://dev.example.org/" />
      {certificates && <TrustedCertificates certificates={certificates} />}
    </> }] : []),
    ...(backups
      ? [{ id: "backups", heading: "Backups", hint: device ? "Copies of this device's data, kept beside it." : host === "web" ? "Copies of the server's data, kept in its data folder. A restore restarts the server." : "Copies of the daemon's data, kept where it runs.", content: <Backups /> }]
      : []),
    ...(desktop || phone_kinds ? [{ id: "notifications", heading: "Notifications", hint: phone_kinds ? "What this phone tells you about runs while X-Dev is open or in the background; tapping one opens the item." : "What this computer tells you about runs while X-Dev is closed or out of sight; clicking one opens the item.", content: <Notifications /> }] : []),
    ...(local_mcp
      ? [{ id: "mcp", heading: "MCP server", hint: "Let AI assistants such as Claude Code on this computer add items and work every control, starting agent runs included, without the server. Without Require a token, any program running on this computer, under any user, can call it and start agent runs.", content: <LocalMcpSettings device={local_mcp} name="x-dev" data_name="add and change your items and start agent runs" /> }]
      : []),
    ...(desktop ? [{ id: "desktop", heading: "Desktop", hint: "The tray icon, and what runs while the window is closed.", content: <Desktop /> }] : []),
  ];
  return sections.length ? [{ heading: host === "web" ? "Server" : "This device", sections }] : [];
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
