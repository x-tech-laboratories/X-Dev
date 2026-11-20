// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import type { RunnerMethods } from "../src/shared/runs/runner.ts";
import { setting_defaults, type DevMethods } from "../src/shared/store.ts";
import type { WebhookMethods, WebhookStatus } from "../src/shared/webhooks/model.ts";
import { set_page_api } from "../src/web/api.ts";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";

afterEach(cleanup);

const calls = { get_settings: vi.fn(async () => setting_defaults) } as unknown as Client<DevMethods>;
// A stand-in the page is shown, made up for the test.
const revealed = ["stand", "in", "value", "for", "tests"].join("-");

function fake_webhooks(can_register: boolean) {
  let status: WebhookStatus = { public_url: "", payload_url: "", content_type: "application/json", events: ["pull_request", "check_suite"], has_secret: false, secret_created_at: "", can_register, deliveries: [] };
  const webhooks = {
    get_github_webhook: vi.fn(async () => status),
    set_github_webhook_url: vi.fn(async (url: string) => (status = { ...status, public_url: url, payload_url: `${url}/api/github/webhook` })),
    create_github_webhook_secret: vi.fn(async () => (status = { ...status, has_secret: true, secret_created_at: new Date().toISOString() })),
    show_github_webhook_setup: vi.fn(async () => ({ payload_url: status.payload_url, content_type: status.content_type, events: status.events, secret: revealed })),
    register_github_webhook: vi.fn(async (repository: string) => `Added the webhook to ${repository}.`),
    deliver: (repository: string) => (status = { ...status, deliveries: [{ repository, delivery_id: "d", event: "check_suite", received_at: new Date().toISOString(), targets: { repository, pull_requests: [], branches: [], issues: [] } }] }),
  };
  return webhooks;
}

describe("webhook settings", () => {
  it("shows what to give GitHub, makes the secret and shows it only when asked", async () => {
    const webhooks = fake_webhooks(false);
    set_page_api({ host: "web", calls, device: null, github_webhook: webhooks as unknown as Client<WebhookMethods>, on_change: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    expect(await screen.findByText("Give the public address first.")).toBeTruthy();
    expect(screen.queryByText("Add to a repository")).toBeNull();
    const address = screen.getByLabelText("Public address") as HTMLInputElement;
    fireEvent.change(address, { target: { value: "https://dev.example.org" } });
    fireEvent.blur(address);
    expect(await screen.findByText("https://dev.example.org/api/github/webhook")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Secret" }));
    await screen.findByRole("button", { name: "Replace Secret" });
    expect(document.body.textContent).not.toContain(revealed);

    fireEvent.click(screen.getByRole("button", { name: "Show Setup" }));
    await waitFor(() => expect(document.body.textContent).toContain(revealed));
    expect(webhooks.show_github_webhook_setup).toHaveBeenCalledTimes(1);
  });

  it("asks before replacing a secret, adds the hook through gh where it can, and lists deliveries", async () => {
    const webhooks = fake_webhooks(true);
    await webhooks.set_github_webhook_url("https://dev.example.org");
    await webhooks.create_github_webhook_secret();
    webhooks.deliver("owner/repo");
    const runner = { get_runner: vi.fn(async () => ({ settings: { repositories: { "owner/repo": "/checkouts/repo" } }, running_run_id: null })), get_github: vi.fn(async () => ({ signed_in: true, account: "tester", problem: "" })) } as unknown as Client<RunnerMethods>;
    set_page_api({ host: "desktop", calls, device: null, runner, github_webhook: webhooks as unknown as Client<WebhookMethods>, on_change: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    expect(await screen.findByText("owner/repo")).toBeTruthy();
    expect(screen.getByText(/Check suites .* ago/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replace Secret" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
    await waitFor(() => expect(webhooks.create_github_webhook_secret).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "owner/repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Webhook" }));
    await waitFor(() => expect(webhooks.register_github_webhook).toHaveBeenCalledWith("owner/repo"));
  });
});
