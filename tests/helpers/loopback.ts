// What the tests that reach daemons over the network share: free loopback ports, throwaway folders and checkouts,
// certificates made with openssl, and a connections list kept in memory.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SavedConnections } from "@x-tech-laboratories/x-libs/connections";
import type { ConnectionStorage } from "@x-tech-laboratories/x-libs/connection_protocol";

// ============================================================================
// Ports and folders
// ============================================================================

// A port nothing listens on, found by asking for any port on the loopback address.
export function free_port(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export function temp_folder(name: string): string {
  return mkdtempSync(join(tmpdir(), `x-dev-${name}-`));
}

// A throwaway git checkout with one commit, standing in for the repository's own.
export function make_checkout(): string {
  const folder = temp_folder("checkout");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(folder, "README.md"), "# Test\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-q", "-m", "chore: start");
  return folder;
}

// ============================================================================
// Certificates
// ============================================================================

// A certificate that signs itself for localhost and 127.0.0.1, as a home server's often does, made in a folder of its own.
export function self_signed_certificate(): { certificate_file: string; key_file: string } {
  const folder = temp_folder("certificate");
  const certificate_file = join(folder, "daemon.pem");
  const key_file = join(folder, "daemon.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key_file, "-out", certificate_file, "-days", "30", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  return { certificate_file, key_file };
}

// ============================================================================
// Connections
// ============================================================================

// The daemons a device knows, kept in memory rather than in a file.
export function memory_connection_storage(): ConnectionStorage {
  let saved: SavedConnections | null = null;
  return {
    read: () => saved,
    write: (next) => {
      saved = next;
    },
  };
}
