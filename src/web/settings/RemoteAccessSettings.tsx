// "Let other devices connect": whether this computer's daemon listens on the network, where, over https or not, and
// the admins a phone, a browser or another computer signs in as.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState, type FormEvent } from "react";
import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { StatusPill } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";

import type { RemoteAccessMethods, RemoteAccessSettings as Settings, RemoteAccessStatus } from "../../shared/remote_access.ts";
import { attempt, show_error } from "../api.ts";

// ── Section ──────────────────────────────────────────────────────────────────

export function RemoteAccessSettings({ remote }: { remote: Client<RemoteAccessMethods> }) {
  const [status, set_status] = useState<RemoteAccessStatus | null>(null);
  const [draft, set_draft] = useState<Settings | null>(null);
  const [name, set_name] = useState("");
  const [password, set_password] = useState("");

  useEffect(() => {
    void remote.get_remote_access().then((found) => {
      set_status(found);
      set_draft(found.settings);
    }, show_error);
  }, [remote]);

  if (!status || !draft) return null;

  async function save(next: Settings): Promise<void> {
    const saved = await attempt(() => remote.set_remote_access(next));
    if (saved) {
      set_status(saved);
      set_draft(saved.settings);
    }
  }

  async function add_admin(): Promise<void> {
    const saved = await attempt(() => remote.set_remote_admin(name, password), `${name.trim()} can sign in from other devices.`);
    if (!saved) return;
    set_status(saved);
    set_name("");
    set_password("");
  }

  function remove_admin(admin: string): void {
    confirm_dialog({
      title: `Remove ${admin}?`,
      message: "Devices signed in as them can no longer reach this computer.",
      confirm_label: "Remove",
      danger: true,
      run: async () => void (await attempt(() => remote.remove_remote_admin(admin)).then((saved) => saved && set_status(saved))),
    });
  }

  const field = (key: "host" | "certificate_file" | "key_file", label: string, hint: string, placeholder = "") => (
    <SettingRow label={label} hint={hint} as_label>
      <input type="text" spellCheck={false} placeholder={placeholder} value={draft[key]} onChange={(event) => set_draft({ ...draft, [key]: event.currentTarget.value })} />
    </SettingRow>
  );
  const is_changed = JSON.stringify(draft) !== JSON.stringify(status.settings);
  const state = status.listening ? <StatusPill tone="good" label={`Listening on ${status.listening}`} /> : status.problem ? <StatusPill tone="bad" label={status.problem} /> : <StatusPill label="Off" />;

  return (
    <>
      <SettingRow label="Let other devices connect" hint="Phones, browsers and other computers sign in as an admin below and can start runs here with this computer's rights. Use https, a VPN or a reverse proxy; plain http sends passwords and tokens as they are." as_label>
        <Switch label="Let other devices connect" checked={status.settings.enabled} on_change={(on) => void save({ ...draft, enabled: on })} />
      </SettingRow>
      <SettingRow label="State">{state}</SettingRow>
      {field("host", "Address", "Where to listen: 0.0.0.0 for every network, or one address such as a VPN's.", "0.0.0.0")}
      <SettingRow label="Port" as_label>
        <input type="number" min={1} max={65535} value={draft.port} onChange={(event) => set_draft({ ...draft, port: Number(event.currentTarget.value) })} />
      </SettingRow>
      {field("certificate_file", "Certificate file", "The https certificate, as a PEM file; empty for plain http.", "/path/to/cert.pem")}
      {field("key_file", "Key file", "The certificate's private key, as a PEM file.", "/path/to/key.pem")}
      <SettingRow label="Save" hint="Listens again with these settings.">
        <button type="button" disabled={!is_changed} onClick={() => void save(draft)}>Save</button>
      </SettingRow>
      {status.admins.map((admin) => (
        <SettingRow key={admin} label={admin} hint="An admin who may sign in from other devices">
          <button type="button" className="danger" onClick={() => remove_admin(admin)}>Remove</button>
        </SettingRow>
      ))}
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void add_admin(); }}>
        <SettingRow label="Admin name" hint="Signing in again with a new password changes it." as_label>
          <input type="text" autoCapitalize="none" spellCheck={false} autoComplete="off" value={name} onChange={(event) => set_name(event.currentTarget.value)} />
        </SettingRow>
        <SettingRow label="Password" hint="At least 10 characters." as_label>
          <input type="password" autoComplete="new-password" value={password} onChange={(event) => set_password(event.currentTarget.value)} />
        </SettingRow>
        <SettingRow label="Add an admin">
          <button type="submit" disabled={name.trim() === "" || password === ""}>Add Admin</button>
        </SettingRow>
      </form>
    </>
  );
}
