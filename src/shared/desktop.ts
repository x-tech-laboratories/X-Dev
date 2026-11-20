// The desktop app's own settings, kept by its daemon beside the database rather than synced, since they belong to this
// computer: the tray icon, running on with the window closed, starting at login, and which notifications it shows.

// ── Settings ─────────────────────────────────────────────────────────────────

export interface DesktopSettings {
  show_tray_icon: boolean;
  keep_running_in_background: boolean;
  start_at_login: boolean;
  // Each kind of notification the daemon shows about runs and pull requests on this computer.
  notify_run_finished: boolean;
  notify_run_failed: boolean;
  notify_run_asked: boolean;
  notify_run_proposed: boolean;
  notify_checks_finished: boolean;
}

export const desktop_setting_defaults: DesktopSettings = {
  show_tray_icon: true,
  keep_running_in_background: true,
  start_at_login: true,
  notify_run_finished: true,
  notify_run_failed: true,
  notify_run_asked: true,
  notify_run_proposed: true,
  notify_checks_finished: true,
};

// Settings saved on the device, each default where it is missing or damaged.
export function read_desktop_settings(saved: unknown): DesktopSettings {
  const settings = (saved ?? {}) as Partial<Record<keyof DesktopSettings, unknown>>;
  const flag = (key: keyof DesktopSettings): boolean => (typeof settings[key] === "boolean" ? settings[key] : desktop_setting_defaults[key]);
  return Object.fromEntries((Object.keys(desktop_setting_defaults) as (keyof DesktopSettings)[]).map((key) => [key, flag(key)])) as unknown as DesktopSettings;
}

// ── Calls ────────────────────────────────────────────────────────────────────

// What the page asks of the desktop app; quitting completely also stops the daemon.
export interface DesktopMethods {
  get_desktop_settings: () => DesktopSettings;
  set_desktop_setting: <Key extends keyof DesktopSettings>(key: Key, value: DesktopSettings[Key]) => void;
  quit_completely: () => void;
  // A folder the user picks in the system's dialog, starting from the one given, or null when they cancel.
  pick_folder: (current: string) => string | null;
}

export const desktop_method_names = ["get_desktop_settings", "set_desktop_setting", "quit_completely", "pick_folder"] as const satisfies readonly (keyof DesktopMethods)[];

// What the daemon answers about itself: its settings, and stopping.
export interface DaemonMethods {
  get_desktop_settings: () => DesktopSettings;
  set_desktop_setting: (key: keyof DesktopSettings, value: boolean) => void;
  stop_daemon: () => void;
}

export const daemon_method_names = ["get_desktop_settings", "set_desktop_setting", "stop_daemon"] as const satisfies readonly (keyof DaemonMethods)[];
