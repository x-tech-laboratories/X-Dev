// "Let other devices connect": the daemon's own network address, behind the same sign-in as the web server, kept in
// the profile folder with the admins who may sign in from elsewhere. It listens only while turned on, and the settings
// and admins change only over the daemon's own socket.

// ── Imports ──────────────────────────────────────────────────────────────────

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { account_name_pattern, hash_password, parse_accounts, set_account, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";

import { read_remote_access, remote_access_problem, type RemoteAccessMethods, type RemoteAccessSettings, type RemoteAccessStatus } from "../shared/remote_access.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface RemoteAccessOptions {
  // The profile folder, which keeps remote.json and the admins' accounts file.
  profile: string;
  // Builds the server other devices reach, signing in the admins given.
  build: (admins: Accounts, https: { cert: Buffer; key: Buffer } | undefined) => Promise<FastifyInstance>;
}

export interface RemoteAccess {
  methods: RemoteAccessMethods;
  // Listens when turned on, or again after the database was swapped by a restore.
  restart: () => Promise<void>;
  stop: () => Promise<void>;
}

const shortest_password = 10;

// ── Remote access ────────────────────────────────────────────────────────────

export function create_remote_access({ profile, build }: RemoteAccessOptions): RemoteAccess {
  const settings_file = join(profile, "remote.json");
  const accounts_file = join(profile, "remote-admins");
  let server: FastifyInstance | null = null;
  let listening = "";
  let problem = "";

  function read_settings(): RemoteAccessSettings {
    return read_remote_access(existsSync(settings_file) ? JSON.parse(readFileSync(settings_file, "utf8")) : null);
  }

  function read_admins(): Accounts {
    return existsSync(accounts_file) ? parse_accounts(readFileSync(accounts_file, "utf8"), accounts_file) : new Map();
  }

  // Only this user may read the hashes.
  function write_admins(text: string): void {
    mkdirSync(profile, { recursive: true });
    writeFileSync(accounts_file, text, { mode: 0o600 });
    chmodSync(accounts_file, 0o600);
  }

  function status(): RemoteAccessStatus {
    return { settings: read_settings(), admins: [...read_admins().keys()].sort(), listening, problem };
  }

  async function stop(): Promise<void> {
    const closing = server;
    server = null;
    listening = "";
    await closing?.close();
  }

  async function restart(): Promise<void> {
    await stop();
    const settings = read_settings();
    problem = "";
    if (!settings.enabled) return;
    try {
      const admins = read_admins();
      problem = remote_access_problem(settings, [...admins.keys()]);
      if (problem) return;
      const https = settings.certificate_file ? { cert: readFileSync(settings.certificate_file), key: readFileSync(settings.key_file) } : undefined;
      const built = await build(admins, https);
      await built.listen({ host: settings.host, port: settings.port });
      server = built;
      listening = `${https ? "https" : "http"}://${settings.host.includes(":") ? `[${settings.host}]` : settings.host}:${settings.port}`;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
  }

  const methods: RemoteAccessMethods = {
    get_remote_access: status,
    set_remote_access: async (settings) => {
      mkdirSync(profile, { recursive: true });
      writeFileSync(settings_file, JSON.stringify(read_remote_access(settings), null, 2));
      await restart();
      return status();
    },
    set_remote_admin: async (typed_name, password) => {
      const name = typed_name.trim().toLowerCase();
      if (!account_name_pattern.test(name)) throw new Error("A name is lowercase letters, digits, '.', '_' and '-'.");
      if (password.length < shortest_password) throw new Error(`A password needs at least ${shortest_password} characters.`);
      write_admins(set_account(existsSync(accounts_file) ? readFileSync(accounts_file, "utf8") : "", name, hash_password(password)));
      await restart();
      return status();
    },
    remove_remote_admin: async (name) => {
      const kept = [...read_admins()].filter(([admin]) => admin !== name);
      write_admins(kept.map(([admin, stored]) => `${admin}:${stored}\n`).join(""));
      await restart();
      return status();
    },
  };

  return { methods, restart, stop };
}
