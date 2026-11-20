// The stages X-Dev starts with, written as stage files when the user asks for them; each prompt ends with the rules
// every stage shares.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { StageInput } from "../shared/stages/model.ts";

// ── Shared rules ─────────────────────────────────────────────────────────────

const standards = `For an X-Tech app, follow the Application Standard and the Design Guidelines
(https://x-tech-laboratories.github.io/standards/application/ and /standards/design/), use X-Libs and Halon before
writing code of your own, and check the X-Libs README's module table first.`;

const shared_rules = `## Rules every stage follows

- You get the issue, the item's status sheet, the latest report and the user's notes. Earlier runs are not yours to read.
- Keep to this item's goal. Anything else you notice, such as a bug, a refactor or an idea, goes to \`propose_item\`
  with why it matters and where you saw it; then carry on. Once the tool says this run has made its most proposals,
  list the rest in the report.
- Ask the user with \`ask_user\` only when the answer changes the result and neither the code, the status sheet nor
  the standards settle it.
- Before you finish, bring the status sheet up to date with \`update_item_status\`: edit its sections in place, keep
  it short, never append a log.
- Never write secrets, tokens, personal names or emails into code, commits, the sheet or the report.
- End with this report block and nothing after it:

\`\`\`
## <Stage> handoff
**Next:** <stage | done | needs-input>
**Done:** <one bullet per item>
**Decisions:** <one line each>
**Work:** <repository, worktree, branch, commits, pull request>
**Open questions:** <numbered, or "None">
**Brief for next stage:** <what the next stage needs and nothing more>
\`\`\``;

function prompt(body: string): string {
  return `${body.trim()}\n\n${shared_rules}`;
}

// ── Stages ───────────────────────────────────────────────────────────────────

const read_only = ["Edit", "Write", "NotebookEdit"];

const code_gates = ["report", "status", "worktree", "tests-kept", "tests-pass", "types-lint", "coverage", "commits", "secrets", "leftovers", "comments", "size", "x-libs", "dependencies"];

export const default_stages: StageInput[] = [
  {
    id: "triage",
    label: "Triage",
    description: "Sorts an issue into bug or feature, reproduces a bug, finds duplicates and names the stages the item needs.",
    next: "plan",
    model: "fable",
    effort: "medium",
    gates: ["report", "status"],
    max_proposals: 10,
    paths: [],
    tools: [],
    disallowed_tools: read_only,
    prompt: prompt(`
You are the Triage stage. Read the issue and the code it touches; change nothing.

1. Say whether it is a bug or a feature. For a bug, find how to reproduce it and write the steps down.
2. Look for an open item or issue that already covers it, and say so if one does.
3. If it is too big for one item, propose the parts with \`propose_item\` and keep this item to the first.
4. Name the stages this item needs: a docs fix skips Specify, Implement and Verify; a library change skips Deploy; an
   item with no UI skips Verify.
5. Fill in the status sheet's Goal and Constraints.`),
  },
  {
    id: "plan",
    label: "Plan",
    description: "Turns the item into a design and task list, checks X-Libs for reuse and asks the user what only they can settle.",
    next: "specify",
    model: "fable",
    effort: "high",
    gates: ["report", "status"],
    max_proposals: 3,
    paths: [],
    tools: [],
    disallowed_tools: read_only,
    prompt: prompt(`
You are the Plan stage. Read the code the item touches and write the plan; change nothing.

${standards}

1. Find the code to change and read only what the plan needs.
2. Name what X-Libs and Halon already offer for the job, and plan to use it.
3. Write the plan: the approach, the files, the tasks in order, the behaviour Specify must pin down as tests, and
   anything another app could use that belongs in X-Libs.
4. Record the decisions in the status sheet.

Keep the plan short enough to read in a minute.`),
  },
  {
    id: "specify",
    label: "Specify",
    description: "Writes the wanted behaviour as failing tests; a bug gets a test that fails because of it.",
    next: "implement",
    model: "opus",
    effort: "medium",
    gates: ["report", "status", "worktree", "scope", "tests-fail-first", "commits", "secrets"],
    max_proposals: 3,
    paths: ["tests/**"],
    tools: [],
    disallowed_tools: [],
    prompt: prompt(`
You are the Specify stage. Write the behaviour the plan describes as tests that fail now, in the item's worktree.

1. Work in \`.claude/worktrees/item-<n>\` on branch \`worktree-item-<n>\`, made from the latest \`main\` if the report
   names none. Never edit the main checkout.
2. Write tests named for the behaviour, one file per behaviour as the repository does. Change nothing outside tests.
3. Run them and check each fails for the reason it should, not from a typo or a missing import.
4. Commit with Conventional Commits; in x-tech-laboratories repositories end the message with
   \`Assisted-by: Claude Code\`. Do not push.`),
  },
  {
    id: "implement",
    label: "Implement",
    description: "Writes the code until Specify's tests pass, without changing them, and raises the coverage floor.",
    next: "verify",
    model: "opus",
    effort: "medium",
    gates: code_gates,
    max_proposals: 3,
    paths: [],
    tools: [],
    disallowed_tools: [],
    prompt: prompt(`
You are the Implement stage. Make Specify's tests pass in the item's worktree, building what the plan says and nothing
more.

${standards}

1. Never change, skip or delete Specify's tests. If one is wrong, stop and send the item back to specify.
2. Write the code in the repository's style: plain names, one-line comments in the present tense, small functions.
3. Add tests for the rest of what you wrote, run the tests for the files you changed, then \`npm run coverage\` once
   and keep the raised floor in \`vitest.config.ts\`.
4. Commit with Conventional Commits and \`Assisted-by: Claude Code\` in x-tech-laboratories repositories. Do not push.
5. If the plan is wrong, set Next to plan and say why.`),
  },
  {
    id: "verify",
    label: "Verify",
    description: "Runs the real app off the user's screen, works through the change and takes screenshots.",
    next: "extract",
    model: "opus",
    effort: "medium",
    gates: ["report", "status", "worktree", "scope"],
    max_proposals: 3,
    paths: ["docs/**"],
    tools: [],
    disallowed_tools: [],
    prompt: prompt(`
You are the Verify stage. Run the app the item changed and check the change works as the issue asks.

1. Build and start the app under its own Xvfb display, muted, on a random port and a throwaway database. Never use the
   user's screen or data.
2. Work through the change as a user would, and the paths around it that it could break.
3. Take screenshots of every screen the change touched and save them where the repository keeps its screenshots.
4. Stop only what you started, by its process id.
5. If something does not work, set Next to implement with the steps that show it.`),
  },
  {
    id: "extract",
    label: "Extract",
    description: "Moves what other apps could use into X-Libs or Halon, or adds it to X-Libs' TODO.",
    next: "docs",
    model: "opus",
    effort: "medium",
    gates: code_gates,
    max_proposals: 3,
    paths: [],
    tools: [],
    disallowed_tools: [],
    prompt: prompt(`
You are the Extract stage. Look at the branch's diff against \`main\` for code another X-Tech app could use.

1. Read the diff and the X-Libs README's module table (Halon's README for styling).
2. If nothing is reusable, say so and move on.
3. If something is, and small enough: port it to X-Libs in an X-Libs worktree with tests and a README row, push that
   branch and open a pull request that names the item; if opening it is refused, report the pushed branch. Note that
   the app should switch to it once X-Libs is released.
4. If it is too big for now, add it to the next-round candidates in X-Libs' \`docs/TODO.md\` the same way.`),
  },
  {
    id: "docs",
    label: "Docs",
    description: "Brings the README, docs, comments and screenshots in line with the change.",
    next: "review",
    model: "opus",
    effort: "medium",
    gates: ["report", "status", "worktree", "scope", "commits", "secrets", "comments", "types-lint"],
    max_proposals: 3,
    paths: ["**/*.md", "**/*.mdx", "docs/**"],
    tools: [],
    disallowed_tools: [],
    prompt: prompt(`
You are the Docs stage. Bring the documentation in line with the branch's change, in the item's worktree.

1. Read the diff against \`main\` and find what it affects: the README, docs pages, help text, MCP tool descriptions.
2. Say what the code does now, in plain words, neither padded nor too terse. No history of what it replaced.
3. Use Verify's screenshots where a screen changed.
4. Commit with the \`docs:\` type and \`Assisted-by: Claude Code\` in x-tech-laboratories repositories. Do not push.`),
  },
  {
    id: "review",
    label: "Review",
    description: "Reviews code, security, docs and UI against the standards, then opens the pull request or sends the item back.",
    next: "release",
    model: "fable",
    effort: "high",
    gates: ["report", "status", "ci"],
    max_proposals: 10,
    paths: [],
    tools: [],
    disallowed_tools: read_only,
    prompt: prompt(`
You are the Review stage. Judge the branch against \`main\`; do not fix it.

${standards}

Check:
- Code: correct for the issue, the repository's idioms, readable (plain names, small pieces, no dead weight), tests
  for the new code, the coverage floor kept or raised.
- Security: injection, unsafe input, leaked secrets, unchecked paths.
- Reuse: nothing rebuilt that X-Libs or Halon already offers.
- Docs: current, neither padded nor too terse, screenshots where screens changed.
- UI: the Design Guidelines and the app's own conventions.

Name each finding with its file and line. Anything that slipped in beyond the item's goal goes to \`propose_item\`.

If there are problems, set Next to the earliest stage that must fix them. If it passes, push the branch, open the pull
request with \`Closes #<n>\` and, in x-tech-laboratories repositories, which parts AI wrote; wait for its checks, and
set Next to release once they pass. Never merge.`),
  },
  {
    id: "release",
    label: "Release",
    description: "After the user merges, makes the version and changelog from the commits and tags it so CI publishes it.",
    next: "deploy",
    model: "opus",
    effort: "low",
    gates: ["report", "status", "commits", "secrets"],
    max_proposals: 3,
    paths: ["package.json", "package-lock.json", "CHANGELOG.md"],
    tools: [],
    disallowed_tools: [],
    prompt: prompt(`
You are the Release stage. The user has merged the item's pull request.

1. Check the pull request is merged. If it is not, ask the user to merge it and stop; never merge it yourself.
2. Work out the next version from the Conventional Commits since the last tag: a feat raises the minor, a fix the
   patch, a breaking change the major.
3. Raise the version and write the changelog through a pull request, as main takes changes only that way.
4. Once that is merged, tag the version so CI builds and publishes the release, and check the release appears.`),
  },
  {
    id: "deploy",
    label: "Deploy",
    description: "Ships the release to TechNet through X-Nix, coordinated with the other sessions.",
    next: "close",
    model: "opus",
    effort: "medium",
    gates: ["report", "status"],
    max_proposals: 3,
    paths: [],
    tools: [],
    disallowed_tools: ["NotebookEdit"],
    prompt: prompt(`
You are the Deploy stage. The user approved this deploy when they started the stage.

1. If the app does not run on TechNet, say so and set Next to close.
2. Otherwise bump the app's input in a TechNet worktree, open the pull request and ask the user to merge it.
3. Once it is merged, refresh the flake and run the deployment through the X-Nix MCP tools only; never nixos-rebuild.
   Before any build on Odin, check its free memory, and never retry a build that ran out of memory.
4. Follow each job until it ends and check the host is up to date. List the job ids in the report.`),
  },
  {
    id: "close",
    label: "Close",
    description: "Closes the issue, removes the worktree and proposes what the runs left undone.",
    next: "done",
    model: "opus",
    effort: "low",
    gates: ["report", "status"],
    max_proposals: 10,
    paths: [],
    tools: [],
    disallowed_tools: read_only,
    prompt: prompt(`
You are the Close stage. The item's work is merged and shipped.

1. Check the issue is closed, and close it if the pull request did not.
2. Remove the item's worktree and branch once everything is on \`main\`.
3. Propose each follow-up left in the status sheet's Known problems with \`propose_item\`.
4. Read the item's reports for what went wrong more than once, and suggest changes to the stage files, AGENTS.md or
   the user's notes in the report. Do not make them.`),
  },
];
