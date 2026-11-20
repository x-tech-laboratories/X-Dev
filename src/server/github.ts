// GitHub through the gh program the user is signed into, so X-Dev never holds a token: signing gh in and out, finding
// an open issue that matches an item, or opening one for it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";

import { title_likeness } from "../shared/items/model.ts";
import type { GitHubAccount, GitHubSignIn, IssueLink } from "../shared/runs/runner.ts";

// ── Signing in ───────────────────────────────────────────────────────────────

const host = "github.com";

// The account gh is signed into on github.com, or none.
export async function github_account(program = "gh"): Promise<GitHubAccount> {
  const result = await run_program([program, "auth", "status", "--hostname", host], { stdout: "keep", stderr: "keep" });
  if (result.exit_code === 127) return { signed_in: false, account: "", problem: `${program} is not installed or not on the PATH` };
  const account = /Logged in to \S+ (?:account|as) (\S+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1] ?? "";
  return result.exit_code === 0 && account ? { signed_in: true, account, problem: "" } : { signed_in: false, account: "", problem: "" };
}

const code_wait_ms = 20_000;
const device_page = "https://github.com/login/device";

// Starts gh's browser sign-in, giving back the code to enter on GitHub; on_done hears when gh has stored the token.
export function start_github_sign_in(program: string, on_done: (signed_in: boolean) => void): Promise<GitHubSignIn> {
  return new Promise((resolve, reject) => {
    let seen = "";
    let answered = false;
    const watch = {
      write: (chunk: Buffer | string) => {
        seen += chunk.toString();
        const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(seen)?.[1];
        if (code && !answered) {
          answered = true;
          clearTimeout(timer);
          resolve({ code, url: /https:\/\/\S+\/login\/device/.exec(seen)?.[0] ?? device_page });
        }
      },
    };
    const timer = setTimeout(() => {
      if (answered) return;
      answered = true;
      reject(new Error(`gh gave no sign-in code: ${seen.trim().split("\n").at(-1) ?? "no answer"}`));
    }, code_wait_ms);
    // The Enter answers gh's prompt to open a browser; the page offers its own link instead.
    void run_program([program, "auth", "login", "--hostname", host, "--web", "--git-protocol", "ssh", "--skip-ssh-key"], { stdin: "\n", stdout: "show", stderr: "show", out: watch, err: watch }).then(
      (result) => {
        if (!answered) {
          answered = true;
          clearTimeout(timer);
          reject(new Error(result.exit_code === 127 ? `${program} is not installed or not on the PATH` : `gh could not start signing in: ${seen.trim().split("\n").at(-1) ?? `exit ${result.exit_code}`}`));
        }
        on_done(result.exit_code === 0);
      },
      (error: unknown) => {
        if (!answered) reject(error);
      },
    );
  });
}

// Signs gh out of the account on github.com, for every program on this computer that uses it.
export async function github_sign_out(account: string, program = "gh"): Promise<void> {
  await gh(program, ["auth", "logout", "--hostname", host, "--user", account]);
}

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
