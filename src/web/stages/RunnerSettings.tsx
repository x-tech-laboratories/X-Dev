// The runner's settings, which belong to the computer that runs the agents: the GitHub account gh is signed into, how
// the agents' actions are approved, the claude and gh programs, and the model that fills in a described item.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { CommitInput, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";

import { permission_modes, type GitHubSignIn, type PermissionMode, type RunnerMethods } from "../../shared/runs/runner.ts";
import { model_suggestions } from "../../shared/stages/model.ts";
import { attempt, data_watch, page, succeeds } from "../api.ts";

// ── GitHub ───────────────────────────────────────────────────────────────────

// How often the account is read again while the user finishes signing in on GitHub.
const sign_in_check_ms = 3000;

export function GitHubSettings({ runner }: { runner: Client<RunnerMethods> }) {
  const account = use_resource(() => runner.get_github(), [runner], { watch: data_watch });
  const [signing_in, set_signing_in] = useState<GitHubSignIn | null>(null);

  useEffect(() => {
    if (!signing_in) return;
    if (account.data?.signed_in) return void set_signing_in(null);
    const timer = setInterval(() => data_watch.bump(), sign_in_check_ms);
    return () => clearInterval(timer);
  }, [signing_in, account.data?.signed_in]);

  async function sign_in(): Promise<void> {
    const started = await attempt(() => runner.sign_in_github());
    if (started) set_signing_in(started);
  }

  function sign_out(name: string): void {
    confirm_dialog({
      title: `Sign ${name} out of GitHub?`,
      message: "This signs gh out on this computer, for every program that uses it, not only X-Dev.",
      confirm_label: "Sign Out",
      danger: true,
      run: async () => void (await succeeds(() => runner.sign_out_github()).then(() => data_watch.bump())),
    });
  }

  return (
    <Loaded resource={account}>
      {(found) => (
        <SettingRow label="GitHub account" hint={found.problem || (page().daemon_is_here ? "X-Dev finds and opens issues through gh, which keeps the sign-in; X-Dev never sees the token." : "gh on the computer that runs the agents keeps the sign-in; signing in there gives a code to enter on GitHub's device page from this device.")}>
          {found.signed_in ? (
            <span className="inline-row">
              <span>Signed in as {found.account}</span>
              <button type="button" onClick={() => sign_out(found.account)}>
                Sign Out
              </button>
            </span>
          ) : signing_in ? (
            <span className="inline-row">
              <span>
                Enter <strong className="sign-in-code">{signing_in.code}</strong> on{" "}
                <a href={signing_in.url} target="_blank" rel="noreferrer">
                  GitHub's device page
                </a>
                ; this updates once you have.
              </span>
            </span>
          ) : (
            <button type="button" className="accent solid" disabled={found.problem !== ""} onClick={() => void sign_in()}>
              Sign In to GitHub
            </button>
          )}
        </SettingRow>
      )}
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

// A daemon elsewhere keeps the programs it starts and how freely its agents act to its own user.
const local_only_hint = " Changed only from X-Dev on the computer that runs the agents.";

export function RunSettings({ runner, is_here }: { runner: Client<RunnerMethods>; is_here: boolean }) {
  const status = use_resource(() => runner.get_runner(), [runner], { watch: data_watch });
  const set = (key: "permission_mode" | "claude_program" | "describer_model" | "gh_program", value: string) => void succeeds(() => runner.set_runner_setting(key, value as never)).then(() => data_watch.bump());

  return (
    <Loaded resource={status}>
      {({ settings }) => (
        <>
          <SettingRow label="Permissions" hint={`How an agent's actions are approved while no one watches.${is_here ? "" : local_only_hint}`}>
            {is_here ? <Select<PermissionMode> label="Permissions" bare options={permission_modes.map((mode) => [mode, mode_labels[mode]])} value={settings.permission_mode} on_change={(mode) => set("permission_mode", mode)} /> : <span>{mode_labels[settings.permission_mode]}</span>}
          </SettingRow>
          <SettingRow label="Claude program" hint={`The claude command, found on the PATH unless a full path is given.${is_here ? "" : local_only_hint}`}>
            <CommitInput aria-label="Claude program" disabled={!is_here} value={settings.claude_program} on_commit={(event) => set("claude_program", event.currentTarget.value)} />
          </SettingRow>
          <SettingRow label="GitHub program" hint={`The gh command, signed into GitHub, through which issues are found and opened; X-Dev never holds a token.${is_here ? "" : local_only_hint}`}>
            <CommitInput aria-label="GitHub program" disabled={!is_here} value={settings.gh_program} on_commit={(event) => set("gh_program", event.currentTarget.value)} />
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
