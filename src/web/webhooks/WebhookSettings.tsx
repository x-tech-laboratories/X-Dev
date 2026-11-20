// The GitHub webhook settings: what to enter on GitHub's Add webhook form, the secret made and replaced here, adding
// the hook through gh where this host can, and the latest delivery from each repository.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type FormEvent } from "react";
import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { format_age } from "@x-tech-laboratories/x-libs/durations";
import { show_once } from "@x-tech-laboratories/x-libs/web/react/accounts";
import { StatusPill } from "@x-tech-laboratories/x-libs/web/react/badges";
import { CommitInput } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import type { RunnerMethods } from "../../shared/runs/runner.ts";
import type { WebhookMethods, WebhookStatus } from "../../shared/webhooks/model.ts";
import { attempt, data_watch } from "../api.ts";

// ── Section ──────────────────────────────────────────────────────────────────

const event_labels: Record<string, string> = {
  ping: "Ping",
  pull_request: "Pull requests",
  check_suite: "Check suites",
  check_run: "Check runs",
  status: "Statuses",
  workflow_run: "Workflow runs",
  issues: "Issues",
  issue_comment: "Issue comments",
};

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(() => toast("Copied."));
}

// Such as "2 minutes ago".
function age_of(time: string, now: number): string {
  return format_age(Math.max(0, Math.round((now - Date.parse(time)) / 1000)));
}

// The runner, where there is one, offers its checkouts' repositories to add the hook to.
export function WebhookSettings({ webhooks, runner }: { webhooks: Client<WebhookMethods>; runner?: Client<RunnerMethods> | undefined }) {
  const status = use_resource(() => webhooks.get_github_webhook(), [webhooks], { watch: data_watch });
  const known = use_resource(async () => (runner ? Object.keys((await runner.get_runner()).settings.repositories).sort() : []), [runner]);
  const repositories = known.data ?? [];
  const [repository, set_repository] = useState("");

  const saved = (next: WebhookStatus | undefined) => void (next && data_watch.bump());

  function create_secret(found: WebhookStatus): void {
    const create = async () => saved(await attempt(() => webhooks.create_github_webhook_secret(), "Made a new secret; give it to GitHub under Show Setup."));
    if (!found.has_secret) return void create();
    confirm_dialog({
      title: "Replace the webhook secret?",
      message: "GitHub's deliveries signed with the old secret are refused until each hook is given the new one.",
      confirm_label: "Replace",
      danger: true,
      run: create,
    });
  }

  async function show_setup(): Promise<void> {
    const setup = await attempt(() => webhooks.show_github_webhook_setup());
    if (!setup) return;
    show_once("Webhook setup", "Enter these on the repository's Settings → Webhooks → Add webhook page. Keep the secret like a password.", [
      `Payload URL: ${setup.payload_url || "(give the public address first)"}`,
      `Content type: ${setup.content_type}`,
      `Secret: ${setup.secret}`,
      `Events: ${setup.events.join(", ")}`,
    ]);
  }

  async function register(event: FormEvent): Promise<void> {
    event.preventDefault();
    const done = await attempt(() => webhooks.register_github_webhook(repository));
    if (done) {
      toast(done, { tone: "good" });
      set_repository("");
    }
  }

  return (
    <Loaded resource={status}>
      {(found) => {
        const now = Date.now();
        return (
          <>
            <SettingRow label="Public address" hint="The address GitHub reaches this X-Dev at, such as https://dev.example.org. A desktop X-Dev that GitHub cannot reach, such as one behind a home router, keeps polling instead." as_label>
              <CommitInput aria-label="Public address" type="url" spellCheck={false} placeholder="https://dev.example.org" value={found.public_url} on_commit={(event) => void attempt(() => webhooks.set_github_webhook_url(event.currentTarget.value)).then(saved)} />
            </SettingRow>
            <SettingRow label="Payload URL" hint="What to enter as the hook's Payload URL on GitHub.">
              {found.payload_url ? (
                <span className="inline-row">
                  <code className="webhook-url">{found.payload_url}</code>
                  <button type="button" onClick={() => copy(found.payload_url)}>Copy</button>
                </span>
              ) : (
                <span>Give the public address first.</span>
              )}
            </SettingRow>
            <SettingRow label="Content type">
              <code>{found.content_type}</code>
            </SettingRow>
            <SettingRow label="Events" hint={`Choose “Let me select individual events” on GitHub and tick ${found.events.map((event) => event_labels[event] ?? event).join(", ")}; any other event is ignored.`}>
              <span>{found.events.length} events</span>
            </SettingRow>
            <SettingRow label="Secret" hint={found.has_secret ? `Made ${age_of(found.secret_created_at, now)}. GitHub signs every delivery with it; unsigned ones are refused.` : "GitHub signs every delivery with it; until one is made, every delivery is refused."}>
              <span className="inline-row">
                {found.has_secret ? <StatusPill tone="good" label="Set" /> : <StatusPill label="None" />}
                <button type="button" className={found.has_secret ? "" : "accent solid"} onClick={() => create_secret(found)}>
                  {found.has_secret ? "Replace Secret" : "Create Secret"}
                </button>
                <button type="button" disabled={!found.has_secret} onClick={() => void show_setup()}>
                  Show Setup
                </button>
              </span>
            </SettingRow>
            {found.can_register && (
              <form onSubmit={(event) => void register(event)}>
                <SettingRow label="Add to a repository" hint="Adds the hook through gh on this computer, or updates the one already sending here." as_label>
                  <span className="inline-row">
                    <input type="text" aria-label="Repository" list="webhook-repositories" spellCheck={false} placeholder="owner/name" value={repository} onChange={(event) => set_repository(event.currentTarget.value)} />
                    <datalist id="webhook-repositories">
                      {repositories.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                    <button type="submit" disabled={!found.payload_url || !found.has_secret || repository.trim() === ""}>
                      Add Webhook
                    </button>
                  </span>
                </SettingRow>
              </form>
            )}
            {found.deliveries.length === 0 ? (
              <SettingRow label="Deliveries" hint="Until a delivery arrives, X-Dev polls GitHub every five minutes, and every half minute while checks run.">
                <span>None yet</span>
              </SettingRow>
            ) : (
              found.deliveries.map((delivery) => (
                <SettingRow key={delivery.repository} label={delivery.repository} hint="The latest delivery from this repository; while they keep coming it is polled only every five minutes.">
                  <span>
                    {event_labels[delivery.event] ?? delivery.event} {age_of(delivery.received_at, now)}
                  </span>
                </SettingRow>
              ))
            )}
          </>
        );
      }}
    </Loaded>
  );
}
