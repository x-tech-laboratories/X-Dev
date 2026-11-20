// "Let other devices connect": the desktop daemon's own network address, off unless turned on, behind the X-Libs
// sign-in, so a phone, a browser or another computer's X-Dev can reach the computer that holds the checkouts.

// ── Settings ─────────────────────────────────────────────────────────────────

export interface RemoteAccessSettings {
  enabled: boolean;
  // The address to listen on, such as 0.0.0.0 for every network or a VPN's own address.
  host: string;
  port: number;
  // The https certificate and key files; both empty for plain http, which only a VPN or a reverse proxy should carry.
  certificate_file: string;
  key_file: string;
}

export const remote_access_defaults: RemoteAccessSettings = { enabled: false, host: "0.0.0.0", port: 7760, certificate_file: "", key_file: "" };

const host_pattern = /^[A-Za-z0-9.:[\]_-]+$/;

// Settings saved on the computer, each default where it is missing or damaged.
export function read_remote_access(saved: unknown): RemoteAccessSettings {
  const fields = (saved ?? {}) as Partial<Record<keyof RemoteAccessSettings, unknown>>;
  const port = Number(fields.port);
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return {
    enabled: fields.enabled === true,
    host: typeof fields.host === "string" && host_pattern.test(fields.host.trim()) ? fields.host.trim() : remote_access_defaults.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : remote_access_defaults.port,
    certificate_file: text(fields.certificate_file),
    key_file: text(fields.key_file),
  };
}

// Why the settings cannot be used as they are, or "" when they can.
export function remote_access_problem(settings: RemoteAccessSettings, admins: string[]): string {
  if (!settings.enabled) return "";
  if (admins.length === 0) return "Add an admin first, so a device has someone to sign in as.";
  if ((settings.certificate_file === "") !== (settings.key_file === "")) return "Give both the certificate and its key, or neither.";
  return "";
}

// ── Calls ────────────────────────────────────────────────────────────────────

export interface RemoteAccessStatus {
  settings: RemoteAccessSettings;
  // The names that sign in from other devices as admins.
  admins: string[];
  // The address other devices reach, such as https://0.0.0.0:7760, or "" while not listening.
  listening: string;
  // Why it is not listening though turned on; "" otherwise.
  problem: string;
}

// Answered only over the daemon's own socket, so only this computer's user changes who may connect.
export interface RemoteAccessMethods {
  get_remote_access: () => RemoteAccessStatus;
  set_remote_access: (settings: RemoteAccessSettings) => Promise<RemoteAccessStatus>;
  // Adds an admin or changes their password.
  set_remote_admin: (name: string, password: string) => Promise<RemoteAccessStatus>;
  remove_remote_admin: (name: string) => Promise<RemoteAccessStatus>;
}

export const remote_access_method_names = ["get_remote_access", "set_remote_access", "set_remote_admin", "remove_remote_admin"] as const satisfies readonly (keyof RemoteAccessMethods)[];
