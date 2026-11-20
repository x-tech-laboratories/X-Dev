// The desktop app's window, tray and login entry, leaving the work to this computer's daemon or one chosen elsewhere.

// ── Imports ──────────────────────────────────────────────────────────────────

import { watchFile } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from "electron";
import { launch_command, set_autostart } from "@x-tech-laboratories/x-libs/autostart";
import { bring_to_front, first_argument, hold_single_instance } from "@x-tech-laboratories/x-libs/electron/app";
import type { Implementation, IpcMainEventLike } from "@x-tech-laboratories/x-libs/electron/bridge";
import { create_app_tray } from "@x-tech-laboratories/x-libs/electron/tray";
import { create_window, is_app_page } from "@x-tech-laboratories/x-libs/electron/window";
import { Notifier } from "@x-tech-laboratories/x-libs/agent/desktop_notify";
import { create_certificate_trust } from "@x-tech-laboratories/x-libs/certificates";
import { connection_file_storage } from "@x-tech-laboratories/x-libs/connection_file_storage";
import { create_connections } from "@x-tech-laboratories/x-libs/connections";
import { create_daemon_link } from "@x-tech-laboratories/x-libs/daemon_link";
import { backup_method_names } from "@x-tech-laboratories/x-libs/backup_protocol";
import { call_daemon, daemon_log_path, daemon_socket_path, start_daemon } from "@x-tech-laboratories/x-libs/local_daemon";
import { certificate_method_names } from "@x-tech-laboratories/x-libs/certificate_protocol";
import { local_mcp_method_names } from "@x-tech-laboratories/x-libs/local_mcp_protocol";

import { backup_bridge, certificate_bridge, connection_bridge, desktop_bridge, device_bridge, dev_bridge, dev_events, local_mcp_bridge, remote_access_bridge, runner_bridge, stages_bridge, webhook_bridge } from "../shared/bridge.ts";
import type { DesktopMethods, DesktopSettings } from "../shared/desktop.ts";
import { remote_access_method_names } from "../shared/remote_access.ts";
import { route_of_link } from "../shared/links.ts";
import { device_method_names } from "../shared/page_api.ts";
import { runner_method_names } from "../shared/runs/runner.ts";
import { stages_method_names } from "../shared/stages/model.ts";
import { webhook_method_names } from "../shared/webhooks/model.ts";
import { method_names } from "../shared/store.ts";
import type { Item } from "../shared/items/model.ts";
import { create_daemon_router } from "./daemon_router.ts";
import { tray_view, type TrayState } from "./tray_menu.ts";

// ── Profile ──────────────────────────────────────────────────────────────────

// Dev runs set this so they never touch the installed app's data.
const is_own_profile = process.env.X_DEV_USER_DATA === undefined;
if (!is_own_profile) app.setPath("userData", join(process.cwd(), process.env.X_DEV_USER_DATA!));

const profile = app.getPath("userData");
const database_path = join(profile, "dev.db");

// Any other profile gets a daemon, socket and log of its own, so a dev or test run never reaches the user's daemon.
const socket_path = daemon_socket_path({ app: "x-dev", data_file: is_own_profile ? null : database_path });
const log_file = is_own_profile ? daemon_log_path("x-dev") : join(profile, "daemon.log");
// A dev or test profile keeps stages of its own, so it never edits the stages Claude Code runs.
const stages_folder = is_own_profile ? undefined : join(profile, "stages");

// The built app sits in out/main, and resources/ beside out/ both in the source tree and in the package.
const icon_path = join(import.meta.dirname, "../../resources/icon.png");

// The command that starts this app again, which the login entry runs.
const own_command = (args: string[]): string[] =>
  launch_command({ launcher: process.env.X_DEV_LAUNCHER, is_packaged: app.isPackaged, app_path: app.getAppPath(), args });

// ── Daemon ───────────────────────────────────────────────────────────────────

function ensure_daemon(): Promise<unknown> {
  return start_daemon({
    socket_path,
    script: join(import.meta.dirname, "daemon.js"),
    env: { X_DEV_DB: database_path, X_DEV_SOCKET: socket_path, X_DEV_VERSION: app.getVersion(), ...(stages_folder ? { X_DEV_STAGES: stages_folder } : {}) },
    log_file,
  });
}

// ── Connections ──────────────────────────────────────────────────────────────

// Certificates the user trusted, read again whenever the daemon saves the list, so calls to another computer honour them.
const certificates_file = join(profile, "trusted-certificates.json");
const trust_certificates = (): void => void create_certificate_trust({ file: certificates_file, use_in_node: true });
trust_certificates();
watchFile(certificates_file, { interval: 2000 }, trust_certificates);

// This computer's daemon, and daemons on other computers each signed in once with a token of this device's own.
const connections = create_connections({ storage: connection_file_storage(join(profile, "connections.json")), offers_local: true, device_name: `X-Dev on ${hostname()}` });
const link = create_daemon_link({ connections, socket_path });

// Calls and change events go to this computer's daemon or the chosen one; another daemon chosen reloads every window.
const router = create_daemon_router({
  connections,
  link,
  call_local: (path, args, headers) => call_daemon(socket_path, path, args, headers),
  restart_local: ensure_daemon,
  on_change: () => {
    dev_events.emit(BrowserWindow.getAllWindows(), "changed", null);
    void apply_window_settings().catch(() => undefined);
    void tray.refresh();
  },
  on_sync_status: (status) => dev_events.emit(BrowserWindow.getAllWindows(), "sync_status", status),
  on_switch: () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.reload();
  },
  // A change also shows in the tray at once.
  after_write: () => void tray.refresh(),
  show_notice: (notice) => void notifier.show({ title: notice.title, body: notice.body, key: notice.key, url: notice.url, icon: "app" }),
});
const { call, forwarded, get_desktop_settings, is_here } = router;

// Settings the window itself acts on: the tray and starting at login.
async function apply_window_settings(): Promise<void> {
  const settings = await get_desktop_settings();
  tray.set_shown(settings.show_tray_icon);
  apply_autostart(settings);
}

// Only the user's own profile starts at login; a dev run never writes the login entry.
function apply_autostart(settings: DesktopSettings): void {
  if (!is_own_profile) return;
  set_autostart(
    { id: "x-dev-daemon", name: "X-Dev in the background", comment: "Sync and backups for X-Dev", icon: icon_path, command: own_command(["--daemon"]) },
    settings.start_at_login && settings.keep_running_in_background,
  );
}

// ── Notifications from another computer ──────────────────────────────────────

const notifier = new Notifier({ app_name: "X-Dev", icons: { app: icon_path }, on_error: (message) => console.error(`x-dev notifications: ${message}`) });

// ── Window ───────────────────────────────────────────────────────────────────

const page = {
  dev_url: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
  file: join(import.meta.dirname, "../renderer/index.html"),
};

function open_window(): BrowserWindow {
  return create_window(BrowserWindow, {
    ...page,
    title: "X-Dev",
    icon: icon_path,
    // electron-vite emits an ESM preload as .mjs; loading .js here silently yields no bridge.
    preload: join(import.meta.dirname, "../preload/index.mjs"),
    default_size: { width: 1100, height: 760 },
    min_size: { width: 360, height: 480 },
    native_theme: nativeTheme,
    shell,
    screen,
    state_file: join(profile, "window.json"),
  });
}

// Brings the window forward, making one if it was closed, and hands it the route once its page listens.
function show_window(route?: string): void {
  const existing = BrowserWindow.getAllWindows()[0];
  const window = existing ?? open_window();
  bring_to_front(window);
  if (!route) return;
  if (existing) dev_events.emit([window], "open", route);
  else window.webContents.once("did-finish-load", () => dev_events.emit([window], "open", route));
}

// Stops the daemon as well, so nothing runs until the app is opened again.
async function quit_completely(): Promise<void> {
  router.quitting();
  await call("daemon/stop_daemon", []).catch(() => undefined);
  app.quit();
}

// ── Tray icon ────────────────────────────────────────────────────────────────

async function read_tray_state(): Promise<TrayState> {
  const items = (await call("call/list_items", [false])) as Item[];
  return { open_items: items.length };
}

// The tray brings the window forward, making one again if it was closed, and opens the page where a row points.
// Its own calls go with this process's client id, and the page hears of them as a change from elsewhere.
const tray = create_app_tray({
  electron: { Tray, Menu, nativeImage },
  icon_path,
  on_click: () => show_window(),
  on_error: (error) => console.error(error),
  read: async () =>
    tray_view(await read_tray_state(), {
      open_route: (route) => show_window(route),
      show: () => show_window(),
      quit: () => {
        router.quitting();
        app.quit();
      },
      quit_completely: () => void quit_completely(),
    }),
});

// ── Bridges ──────────────────────────────────────────────────────────────────

// Only the app's own page may call in, never a site a link led to.
function trusted(event: IpcMainEventLike): boolean {
  return is_app_page(event.senderFrame?.url ?? "", page);
}

// The page's calls go to the daemon, but for quitting and the settings the window acts on.
function register_bridges(): void {
  const options = { trusted, envelopes: true };
  dev_bridge.handle(ipcMain, forwarded(method_names, "call") as never, options);
  connection_bridge.handle(ipcMain, connections.methods, options);
  remote_access_bridge.handle(ipcMain, forwarded(remote_access_method_names, "remote") as never, options);
  // This computer's backups sit with its sync; another computer's are an admin's, beside its other calls.
  backup_bridge.handle(ipcMain, forwarded(backup_method_names, () => (is_here() ? "device" : "backup")) as never, options);
  device_bridge.handle(ipcMain, forwarded(device_method_names, "device") as never, options);
  certificate_bridge.handle(ipcMain, forwarded(certificate_method_names, "certificates") as never, options);
  local_mcp_bridge.handle(ipcMain, forwarded(local_mcp_method_names, "local_mcp") as never, options);
  stages_bridge.handle(ipcMain, forwarded(stages_method_names, "stages") as never, options);
  runner_bridge.handle(ipcMain, forwarded(runner_method_names, "runner") as never, options);
  webhook_bridge.handle(ipcMain, forwarded(webhook_method_names, "github_webhook") as never, options);
  const desktop: Implementation<DesktopMethods> = {
    get_desktop_settings,
    set_desktop_setting: async (key, value) => {
      await call("daemon/set_desktop_setting", [key, value]);
      await apply_window_settings();
    },
    quit_completely,
    pick_folder: async (current) => {
      const window = BrowserWindow.getFocusedWindow();
      const options = { properties: ["openDirectory" as const], ...(current ? { defaultPath: current } : {}) };
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
  };
  desktop_bridge.handle(ipcMain, desktop, options);
}

// ── Start ────────────────────────────────────────────────────────────────────

function start_app(): void {
  void app.whenReady().then(async () => {
    try {
      await ensure_daemon();
    } catch (error) {
      dialog.showErrorBox("X-Dev could not start", `${error instanceof Error ? error.message : String(error)}\n\nSee ${log_file}.`);
      app.exit(1);
      return;
    }
    register_bridges();
    router.start();
    await apply_window_settings().catch(() => undefined);
    // A link the app was opened with, such as a notification's, opens the window on its page.
    show_window(first_argument(process.argv, route_of_link) ?? undefined);
  });

  app.on("will-quit", () => {
    router.stop();
    tray.stop();
  });

  // Closing the window ends only the window, or leaves the app in the tray; the daemon runs on either way.
  app.on("window-all-closed", () => {
    if (!tray.is_shown()) app.quit();
  });
}

// `x-dev-desktop --daemon`, as the login entry runs it, starts only the daemon.
async function start_daemon_alone(): Promise<void> {
  try {
    await ensure_daemon();
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    app.exit(1);
  }
}

// A second launch brings the window forward on the page its link names, but one that only starts the daemon leaves the
// window be.
function open_from_second_launch(argv: string[]): void {
  if (!argv.includes("--daemon")) show_window(first_argument(argv, route_of_link) ?? undefined);
}

if (process.argv.includes("--daemon")) void start_daemon_alone();
else if (hold_single_instance(app, open_from_second_launch)) start_app();
