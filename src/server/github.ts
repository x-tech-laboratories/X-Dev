// GitHub through the gh program the user is signed into, so X-Dev never holds a token: signing gh in and out, finding
// an open issue that matches an item or opening one, its labels, comments, body and closing, and its pull request.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";

import { check_buckets, type CheckBucket, type PullRequestCheck, type PullRequestState } from "../shared/items/github.ts";
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

// Exit codes besides 0 whose output is still the answer, such as gh pr checks while checks run.
async function gh(program: string, args: string[], stdin: string | null = null, also_fine: number[] = []): Promise<string> {
  const result = await run_program([program, ...args], { stdin, stdout: "keep", stderr: "keep" });
  if (result.exit_code === 127) throw new Error(`${program} is not installed or not on the PATH; GitHub is reached through it`);
  if (result.exit_code !== 0 && !(also_fine.includes(result.exit_code) && result.stdout.trim())) throw new Error(`gh ${args[0]} ${args[1]} failed: ${result.stderr.trim().split("\n").at(-1) || `exit ${result.exit_code}`}`);
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

// ── Issue mirror ─────────────────────────────────────────────────────────────

export interface IssueState {
  open: boolean;
  labels: string[];
  body: string;
}

export async function view_issue(repository: string, number: number, program = "gh"): Promise<IssueState> {
  const read = JSON.parse(await gh(program, ["issue", "view", String(number), "--repo", repository, "--json", "state,labels,body"])) as { state: string; labels: { name: string }[]; body: string };
  return { open: read.state === "OPEN", labels: read.labels.map((label) => label.name), body: read.body ?? "" };
}

const labels_listed = 200;
const stage_label_colour = "c5def5";

// Makes the labels named that the repository lacks, leaving every other label alone.
export async function ensure_labels(repository: string, names: string[], program = "gh"): Promise<void> {
  const listed = JSON.parse((await gh(program, ["label", "list", "--repo", repository, "--search", "stage:", "--json", "name", "--limit", String(labels_listed)])) || "[]") as { name: string }[];
  const known = new Set(listed.map((label) => label.name.toLowerCase()));
  for (const name of names.filter((each) => !known.has(each.toLowerCase()))) {
    // Another program may have made it in the meantime, which is as good.
    await gh(program, ["label", "create", name, "--repo", repository, "--color", stage_label_colour, "--description", "The X-Dev stage the item is at"]).catch((error: unknown) => {
      if (!String(error).includes("already exists")) throw error;
    });
  }
}

export interface IssueEdit {
  add_labels?: string[];
  remove_labels?: string[];
  body?: string;
}

export async function edit_issue(repository: string, number: number, edit: IssueEdit, program = "gh"): Promise<void> {
  const args = ["issue", "edit", String(number), "--repo", repository];
  if (edit.add_labels?.length) args.push("--add-label", edit.add_labels.join(","));
  if (edit.remove_labels?.length) args.push("--remove-label", edit.remove_labels.join(","));
  if (edit.body !== undefined) args.push("--body-file", "-");
  await gh(program, args, edit.body ?? null);
}

// Posts a comment on the issue and gives back its id.
export async function post_comment(repository: string, number: number, body: string, program = "gh"): Promise<number> {
  const url = await gh(program, ["issue", "comment", String(number), "--repo", repository, "--body-file", "-"], body);
  const id = Number(/#issuecomment-(\d+)\s*$/.exec(url)?.[1]);
  if (!Number.isInteger(id)) throw new Error(`gh posted a comment but gave no id: ${url}`);
  return id;
}

// Replaces a comment's text; false when the comment is gone, such as deleted on GitHub.
export async function update_comment(repository: string, id: number, body: string, program = "gh"): Promise<boolean> {
  try {
    await gh(program, ["api", "--method", "PATCH", `repos/${repository}/issues/comments/${id}`, "--input", "-"], JSON.stringify({ body }));
    return true;
  } catch (error) {
    if (/Not Found|404/.test(String(error))) return false;
    throw error;
  }
}

export async function close_issue(repository: string, number: number, program = "gh"): Promise<void> {
  await gh(program, ["issue", "close", String(number), "--repo", repository]);
}

// ── Pull requests ────────────────────────────────────────────────────────────

export interface PullRequestFound {
  number: number;
  url: string;
  state: PullRequestState;
  draft: boolean;
}

const pull_request_fields = "number,url,state,isDraft";

function as_found(read: { number: number; url: string; state: string; isDraft?: boolean }): PullRequestFound {
  const state = read.state === "MERGED" ? "merged" : read.state === "CLOSED" ? "closed" : "open";
  return { number: read.number, url: read.url, state, draft: read.isDraft === true };
}

// The newest pull request from the branch, open or not, or null when there is none.
export async function find_pull_request(repository: string, branch: string, program = "gh"): Promise<PullRequestFound | null> {
  const listed = JSON.parse((await gh(program, ["pr", "list", "--repo", repository, "--head", branch, "--state", "all", "--json", pull_request_fields, "--limit", "1"])) || "[]") as Parameters<typeof as_found>[0][];
  return listed[0] ? as_found(listed[0]) : null;
}

export async function view_pull_request(repository: string, number: number, program = "gh"): Promise<PullRequestFound> {
  return as_found(JSON.parse(await gh(program, ["pr", "view", String(number), "--repo", repository, "--json", pull_request_fields])));
}

// gh pr checks ends with 8 while checks run and 1 when one failed, still printing them.
const checks_exit_codes = [1, 8];

// The pull request's checks, each with how it went; none when the branch has no checks yet.
export async function read_checks(repository: string, number: number, program = "gh"): Promise<PullRequestCheck[]> {
  let text: string;
  try {
    text = await gh(program, ["pr", "checks", String(number), "--repo", repository, "--json", "name,bucket,link,workflow"], null, checks_exit_codes);
  } catch (error) {
    if (String(error).includes("no checks reported")) return [];
    throw error;
  }
  const read = JSON.parse(text || "[]") as { name: string; bucket: string; link?: string; workflow?: string }[];
  return read.map((check) => ({ name: check.name, workflow: check.workflow ?? "", bucket: check_buckets.includes(check.bucket as CheckBucket) ? (check.bucket as CheckBucket) : "pending", link: check.link ?? "" }));
}
