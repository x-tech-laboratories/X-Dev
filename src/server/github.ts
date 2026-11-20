// GitHub through the gh program the user is signed into, so X-Dev never holds a token: finding an open issue that
// matches an item, or opening one for it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";

import { title_likeness } from "../shared/items/model.ts";
import type { IssueLink } from "../shared/runs/runner.ts";

// ── Issues ───────────────────────────────────────────────────────────────────

export interface IssueRequest {
  repository: string;
  title: string;
  body: string;
}

// How alike an open issue's title must be to be taken as the same work.
const same_issue_likeness = 0.6;
const issues_searched = 20;

async function gh(program: string, args: string[], stdin: string | null = null): Promise<string> {
  const result = await run_program([program, ...args], { stdin, stdout: "keep", stderr: "keep" });
  if (result.exit_code === 127) throw new Error(`${program} is not installed or not on the PATH; GitHub is reached through it`);
  if (result.exit_code !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed: ${result.stderr.trim().split("\n").at(-1) || `exit ${result.exit_code}`}`);
  return result.stdout.trim();
}

// The open issue whose title is closest to the item's, if close enough to be the same work.
export function best_match(title: string, issues: { number: number; title: string }[]): number | null {
  let best: { number: number; likeness: number } | null = null;
  for (const issue of issues) {
    const likeness = title_likeness(title, issue.title);
    if (likeness >= same_issue_likeness && (!best || likeness > best.likeness)) best = { number: issue.number, likeness };
  }
  return best?.number ?? null;
}

// An open issue that matches the item, or a new one with its title and body.
export async function find_or_open_issue({ repository, title, body }: IssueRequest, program = "gh"): Promise<IssueLink> {
  const listed = await gh(program, ["issue", "list", "--repo", repository, "--state", "open", "--search", `${title} in:title`, "--json", "number,title", "--limit", String(issues_searched)]);
  const found = best_match(title, JSON.parse(listed || "[]") as { number: number; title: string }[]);
  if (found !== null) return { number: found, opened: false };
  const url = await gh(program, ["issue", "create", "--repo", repository, "--title", title, "--body-file", "-"], body || title);
  const number = Number(/\/issues\/(\d+)\s*$/.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new Error(`gh opened an issue but gave no number: ${url}`);
  return { number, opened: true };
}
