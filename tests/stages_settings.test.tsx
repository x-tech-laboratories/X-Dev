// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Toasts } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { create_stage_files } from "../src/server/stage_files.ts";
import type { StagesMethods } from "../src/shared/stages/model.ts";
import { setting_defaults, type DevMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";

afterEach(cleanup);

// The page's stage calls answered by real stage files in a throwaway folder, as the daemon would.
function fake_page(): string {
  const folder = mkdtempSync(join(tmpdir(), "x-dev-stages-"));
  const methods = create_stage_files({ folder }).methods;
  const stages = Object.fromEntries(Object.entries(methods).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  const calls = { get_settings: vi.fn(async () => setting_defaults), set_setting: vi.fn() } as unknown as Client<DevMethods>;
  set_page_api({ host: "desktop", calls, device: null, stages: stages as unknown as Client<StagesMethods>, on_change: () => () => undefined });
  return folder;
}

describe("the stages settings", () => {
  it("adds the default stages and lists each with its model and next stage", async () => {
    fake_page();
    render(<><SettingsView /><Dialogs /></>);

    expect(await screen.findByText("No stages.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add the Default Stages" }));

    const plan = (await screen.findAllByRole("row")).find((row) => row.textContent?.startsWith("Plan"))!;
    expect(within(plan).getByText("fable")).toBeTruthy();
    expect(within(plan).getByText("Specify")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Triage up" })).toHaveProperty("disabled", true);
  });

  it("edits a stage's model in its dialog and writes it to the file", async () => {
    const folder = fake_page();
    render(<><SettingsView /><Dialogs /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Add the Default Stages" }));

    fireEvent.click(await screen.findByRole("button", { name: "Edit Plan" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "opus" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Permission mode" }), { target: { value: "acceptEdits" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(readFileSync(join(folder, "stage-plan.md"), "utf8")).toContain("model: opus"));
    expect(readFileSync(join(folder, "stage-plan.md"), "utf8")).toContain("x-dev-mode: acceptEdits");
    expect(await screen.findByRole("cell", { name: "Edit automatically" })).toBeTruthy();
  });

  it("says why a stage cannot be saved", async () => {
    fake_page();
    render(<><SettingsView /><Dialogs /><Toasts /></>);

    fireEvent.click(await screen.findByRole("button", { name: "Add Stage" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Id"), { target: { value: "Plan Stage" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/"Plan Stage" is not a stage id/)).toBeTruthy();
  });

  it("is left out where no stage files are reached, such as on a phone", async () => {
    const calls = { get_settings: vi.fn(async () => setting_defaults), set_setting: vi.fn() } as unknown as Client<DevMethods>;
    set_page_api({ host: "android", calls, device: null, on_change: () => () => undefined });
    render(<SettingsView />);

    expect(await screen.findByText("Keep changes for")).toBeTruthy();
    expect(screen.queryByText("Stages")).toBeNull();
  });
});
