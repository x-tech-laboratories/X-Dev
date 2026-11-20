// A program that talks in lines both ways while it runs: each line it prints is handed on as it arrives, lines can be
// written to its standard input at any time until the input is closed, and an abort signal stops it and, in its own
// process group, all it started. It is X-Libs' run_program with an open input, never through a shell.

// ── Imports ──────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { constants } from "node:os";

import { BoundedBuffer, kill_grace_in_milliseconds, not_installed_exit_code, signal_group, stderr_limit_in_bytes } from "@x-tech-laboratories/x-libs/agent/programs";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface LineProgramOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  // Called with each whole line the program prints, without its line break.
  on_line: (line: string) => void;
}

export interface LineProgramExit {
  exit_code: number;
  stderr: string;
}

export interface LineProgram {
  // Writes one line to the program's input; ignored once the input is closed or the program has ended.
  write_line: (line: string) => void;
  // Closes the program's input, which tells a program reading it that no more is coming.
  end_input: () => void;
  // Whether the input is still open.
  is_open: () => boolean;
  // Settles once the program has ended; never rejects.
  finished: Promise<LineProgramExit>;
}

// ── Running ──────────────────────────────────────────────────────────────────

export function start_line_program(argv: readonly string[], options: LineProgramOptions): LineProgram {
  if (options.signal?.aborted) return { write_line: () => undefined, end_input: () => undefined, is_open: () => false, finished: Promise.resolve({ exit_code: -1, stderr: "Stopped before it started" }) };
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["pipe", "pipe", "pipe"], env: options.env, cwd: options.cwd });
  let open = true;
  child.stdin.on("error", () => (open = false));
  const stderr = new BoundedBuffer(stderr_limit_in_bytes);
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) options.on_line(line);
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));

  let kill_timer: NodeJS.Timeout | undefined;
  const stop = () => {
    signal_group(child.pid, "SIGTERM");
    kill_timer = setTimeout(() => signal_group(child.pid, "SIGKILL"), kill_grace_in_milliseconds);
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  const finished = new Promise<LineProgramExit>((resolve) => {
    let settled = false;
    const settle = (exit: LineProgramExit) => {
      if (settled) return;
      settled = true;
      open = false;
      clearTimeout(kill_timer);
      options.signal?.removeEventListener("abort", stop);
      resolve(exit);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT";
      settle({ exit_code: missing ? not_installed_exit_code : -1, stderr: missing ? `${argv[0]} is not installed on this host` : `Could not start ${argv[0]}: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      if (pending) options.on_line(pending);
      settle({ exit_code: code ?? 128 + (signal === null ? 0 : constants.signals[signal]), stderr: stderr.text() });
    });
  });

  return {
    write_line: (line) => {
      if (open) child.stdin.write(`${line}\n`);
    },
    end_input: () => {
      if (!open) return;
      open = false;
      child.stdin.end();
    },
    is_open: () => open,
    finished,
  };
}
