#!/usr/bin/env node
// x-dev-check: runs X-Dev's gates on a checkout's changes since a base, so a repository's CI holds every change to the
// same checks a stage's run meets, whether X-Dev made it or not.

// ── Imports ──────────────────────────────────────────────────────────────────

import { parseArgs } from "node:util";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";

import { run_gates } from "../server/gates.ts";
import { gate_names } from "../shared/stages/model.ts";

// ── Options ──────────────────────────────────────────────────────────────────

// The gates that need nothing but the change itself, run when none are named.
export const default_gates = ["commits", "secrets", "leftovers", "comments", "coverage", "x-libs", "dependencies", "size"];

const usage = `Usage: x-dev-check [--base <ref>] [--repository <owner/name>] [gate...]

Runs X-Dev's gates on the changes since the base (the branch point from origin/main unless given) and fails when any
gate fails. With no gates named it runs: ${default_gates.join(", ")}.
Gates: ${gate_names.join(", ")}.`;

async function git(args: string[]): Promise<string> {
  const result = await run_program(["git", ...args], { stdout: "keep", stderr: "keep" });
  if (result.exit_code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// The repository's owner/name from its origin, such as x-tech-laboratories/X-Dev.
export function repository_of_remote(url: string): string {
  return /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? "";
}

// ── Run ──────────────────────────────────────────────────────────────────────

const marks = { passed: "✓", failed: "✗", warning: "!", skipped: "-" } as const;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: "string" }, repository: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const unknown = positionals.filter((gate) => !gate_names.includes(gate));
  if (unknown.length) {
    process.stderr.write(`x-dev-check: no gate called ${unknown.join(", ")}\n\n${usage}\n`);
    return 2;
  }
  const base = values.base ?? (await git(["merge-base", "origin/main", "HEAD"]));
  const repository = values.repository ?? repository_of_remote(await git(["remote", "get-url", "origin"]).catch(() => ""));
  const results = await run_gates(positionals.length ? positionals : default_gates, { worktree: process.cwd(), base, repository, paths: [], specified_tests: [] });
  const lines = results.flatMap((result) => [`${marks[result.outcome]} ${result.gate}: ${result.outcome}`, ...result.findings.map((finding) => `    ${finding}`)]);
  process.stdout.write(`${lines.join("\n")}\n`);
  return results.some((result) => result.outcome === "failed") ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
