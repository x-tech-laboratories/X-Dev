# X-Dev design

X-Dev takes a feature or a bug fix through a fixed set of stages, one stage at a time, each run by an
AI coding agent that sees only what that stage needs. The user starts every stage by hand. A stage is
atomic: it ends by saving a report, and the next stage starts from that report and nothing else.

## Words

- **Item**: one feature or bug fix in one repository, linked to its GitHub issue, with its own git
  worktree and branch.
- **Stage**: one step of the work, defined in a file (see [Stage files](#stage-files)). The default
  stages are listed below.
- **Gate**: a check X-Dev runs itself, not the agent, after a stage; a failed gate keeps the item
  from moving on (see [Gates](#gates)).
- **Run**: one stage run on one item. It keeps the input it was given, the commit it started from,
  the agent's output, the report, the tokens it used and how it ended.
- **Report**: what a run hands to the next stage. It is the only thing a stage passes on.

## The default stages

| Stage     | Does                                                                                   | Can edit |
| --------- | -------------------------------------------------------------------------------------- | -------- |
| Triage    | Sorts the issue into bug or feature, reproduces a bug, finds duplicates, splits an issue too big for one item, and names the stages the item needs | no |
| Plan      | Reads the issue and the code, checks X-Libs and Halon for reuse, writes the plan, asks questions | no |
| Specify   | Writes the behaviour as failing tests, as the [testing guideline](https://x-tech-laboratories.github.io/guidelines/testing/) asks; a bug gets a test that fails because of it | tests only |
| Implement | Writes the code until Specify's tests pass, without changing them, and raises the coverage floor | yes, not Specify's tests |
| Verify    | Runs the real app off the user's screen, under Xvfb, works through the change and takes screenshots | no code |
| Extract   | Moves what other apps could use into X-Libs or Halon, or adds it to X-Libs' TODO        | yes      |
| Docs      | Brings the README, docs, comments and Verify's screenshots in line with the change      | docs only |
| Review    | Reviews code, security, docs and UI against the standards with a different model from Implement's; pushes and opens the pull request when it passes, or sends the item back | no |
| Release   | After the user merges, makes the version and changelog from the commits and tags it, so CI builds and publishes the release | version only |
| Deploy    | Deploys the release to TechNet through X-Nix, coordinated with the other sessions       | no code  |
| Close     | Closes the issue, removes the worktree and branch, and proposes changes to stage files, AGENTS.md or memories from what the runs got wrong | no code |

Triage decides which stages an item takes: a docs fix skips Specify, Implement and Verify, a library
change skips Deploy, and an item with no UI skips Verify. The user can change the list on the item.

Tracking is not a stage: the item and its GitHub issue are the record every stage reads and writes.

## How a stage runs

1. The user presses **Run** for the item's current stage, or picks another stage to send it back to.
2. The daemon builds the input: the issue's title and body, the item's [status sheet](#status-sheet),
   the latest report, and the notes the user added since. Earlier reports and runs' output are left
   out.
3. It runs the stage's agent in the item's worktree, one run at a time across the whole app, and
   streams the output to the page.
4. The agent ends with a report block (below). The daemon saves it, posts it to the issue as a
   comment and moves the issue's `stage:*` label.
5. The user reads the report and can edit it before the next stage reads it.
6. **Discard** drops a run: its report and its status sheet edits are undone and the worktree is
   reset to the commit the run started from. Stages before Review commit but never push, so a
   discard never needs a force-push.

A run that fails, is stopped or loses its daemon ends as failed, keeps its output, and changes
nothing else; the user discards it or runs the stage again.

### Clarifying questions

Any stage can ask the user questions part-way through a run:

- The agent asks through X-Dev's `ask_user` tool with one or more questions, each with its reason and,
  where it can, choices. It then stops, and the run waits as **Waiting for answers**, shown in the
  stage's cell on the board and on the item page, with a notification.
- When the user answers, X-Dev resumes the same agent session with the answers, so the agent goes on
  where it stopped rather than starting again. The questions and answers stay in the run and are
  added to the status sheet's Decisions.
- A waiting run holds the app's one run slot only while the agent is working; other items can run
  while it waits. A run left waiting can still be discarded whole.
- Each stage file says when a question is worth asking: only when the answer changes the result and
  neither the code, the status sheet nor the standards settle it.

### Report block

```
## <Stage> handoff
**Next:** <stage | done | needs-input>
**Done:** <one bullet per item>
**Decisions:** <one line each>
**Work:** <repo, worktree, branch, commits, pull request>
**Open questions:** <numbered, or "None">
**Brief for next stage:** <what the next stage needs and nothing more>
```

Reports go to GitHub, often in public: no secrets, tokens, personal names or emails.

## Status sheet

Every item has one status sheet: a short summary of where the work stands that every stage reads
and keeps current. The report says what the next stage must do; the sheet says what is true of the
item now.

- It has fixed sections: **Goal**, **Current state**, **Decisions**, **Constraints**, **Known
  problems**, **Open questions** and **Links** (branch, pull request, CI).
- Agents read and change it through X-Dev's MCP tools, `get_item_status` and `update_item_status`,
  which reach only the item being run. They edit it in place, never append a log to it.
- It has a size limit; an update past it is refused until the agent shortens the sheet.
- Every stage must update it before it ends, which the `status` gate checks.
- Each edit is kept in the item's history with the run and stage that made it, so it can be traced
  and undone. The user edits it on the item page, and the user's edits win.
- It is mirrored to the top of the issue's body, between `<!-- x-dev-status -->` markers.

A run's full output stays on the item page for the user; it is never handed to an agent.

## Proposals

Any stage can propose new work it comes across, such as a bug it noticed, a refactor or an
improvement, instead of doing it. That keeps each item to its own goal and stops one long run from
building feature after feature.

- The agent calls X-Dev's `propose_item` tool with a title, feature or bug, the repository, why it
  matters and where it was seen (files, lines). It then carries on with its own stage.
- The proposal becomes an item at the **Proposed** stage, before Triage, linked to the item and run
  that raised it. No GitHub issue is made yet, so ideas the user turns down never reach the tracker.
- Before adding one, `propose_item` looks for an open item or proposal in the same repository with a
  close title and adds to it instead, so the same idea is not proposed twice.
- Each stage file caps how many proposals one run may make (`x-dev-max-proposals`, 0 for no limit):
  three unless set, ten for Triage, Review and Close, whose work includes finding follow-ups. Past
  the cap the tool refuses, and the agent lists the rest in its report.
- Proposals wait in an **Inbox** on the board, above the lanes. The user accepts one, which makes its
  GitHub issue and moves it to Triage, merges it into another item, or drops it. Dropped ones stay in
  the history.
- Each stage file tells its agent to propose rather than do anything outside its item's goal, and
  the `scope` gate catches changes outside the paths the stage may touch. Review lists anything that
  slipped in and proposes it as its own item; Close proposes the follow-ups left in Known problems.
- The status sheet's Links section names the proposals an item raised, and each proposal names the
  item it came from.

## Gates

Good practice is enforced by checks, not left to the agent's prompt. After a run, X-Dev runs the
stage's gates in the worktree. A failed gate marks the run failed with what it found, and the item
cannot move on until the stage runs again or the user overrides that gate with a written reason,
which goes into the report and the issue.

The same checks are a command, `x-dev-check [gate...]`, so a repository's CI can run them on every
pull request and nothing that skipped X-Dev gets past them. Checks read only the code around strings
and regular expressions, so a check's own patterns or test data do not trip it. `commits`, `secrets`,
`leftovers`, `comments`, `coverage`, `x-libs` and `dependencies` are X-Libs' change checks, which any
X-app's CI runs with `x-libs-check`; the other gates are X-Dev's own.

| Gate | Checks | After |
| ---- | ------ | ----- |
| `report` | The report block is whole and names a known next stage | every stage |
| `status` | The run updated the status sheet, and the sheet is within its size limit | every stage |
| `worktree` | Nothing changed outside the item's worktree, and the main checkout is untouched | every stage that edits |
| `scope` | Only the paths the stage may touch changed: tests for Specify, docs for Docs, the version for Release | Specify, Docs, Release |
| `tests-fail-first` | Specify's new tests fail on the commit the item started from | Specify |
| `tests-kept` | Specify's tests are unchanged and none is skipped, `.only` or deleted | Implement and later |
| `tests-pass` | The tests for the changed files pass | Implement, Extract |
| `types-lint` | `tsc -b` and `oxlint` are clean | Implement, Extract, Docs |
| `coverage` | The coverage floor in `vitest.config.ts` was not lowered, nothing new is excluded, and a raised floor is committed | Implement, Extract |
| `commits` | Conventional Commits; an `Assisted-by` trailer in `x-tech-laboratories` repositories and nowhere else, and no AI mention outside it | every stage that commits |
| `secrets` | No keys, tokens, private keys or `.env` values in the diff, the commit messages or the report | every stage that edits, and every report |
| `leftovers` | No debug output, commented-out code, unused exports or TODOs without an issue in the diff | Implement, Extract |
| `comments` | Each comment in the diff is one plain line in the present tense | Implement, Extract, Docs |
| `size` | Functions and files over a set length are named for Review (a warning, not a failure) | Implement, Extract |
| `x-libs` | No direct import of a library X-Libs wraps, such as `drizzle-orm` or `@tanstack/react-table`, outside X-Libs itself | Implement, Extract |
| `dependencies` | A new dependency is named for Review, with its licence, which must be one of the licences GPL-3.0-or-later can take in | Implement, Extract |
| `ci` | The pull request's checks pass; checks still running hold the item until they finish | Review |

Review also works from a checklist built from the [Application Standard](https://x-tech-laboratories.github.io/standards/application/),
the [Design Guidelines](https://x-tech-laboratories.github.io/standards/design/) and the guidelines on
[readable code](https://x-tech-laboratories.github.io/guidelines/readable-code/) and
[AI-assisted review](https://x-tech-laboratories.github.io/guidelines/review/). Each finding names a
file and line; a finding is a suggestion until the user accepts it.

A stage file names its gates in `x-dev-gates`. Gates are plugins (`gate`), so a repository can add its
own, such as a firmware build.

## Stage files

Stages are Claude Code agent files in `~/.claude/agents/stage-<name>.md`, so the `/advance` command in
a terminal session and X-Dev run exactly the same stages. The frontmatter is Claude Code's (`name`,
`description`, `model`, `tools`, `disallowedTools`) plus X-Dev's own keys, which Claude Code ignores:

```yaml
x-dev-order: 2          # place in the pipeline
x-dev-next: extract     # the stage that normally follows
x-dev-label: Implement  # the name the page shows
x-dev-gates: [worktree, tests-kept, tests-pass, types-lint, coverage, commits, secrets, leftovers, comments, size, x-libs, dependencies]
x-dev-paths: ["**"]     # what the stage may change; Specify has ["tests/**"]
```

The Stages section of Settings lists them in order and edits each one in a dialog: its name, model,
effort, next stage, gates, tools and prompt, the prompt as plain text so the file keeps it exactly as
typed. Saving writes the file back with its frontmatter, keeping keys and comments X-Dev does not know.
The daemon watches the folder, so a file edited in a text editor shows at once. Stage files are the
user's config, not synced data; the settings export carries them. A dev or test profile keeps its own
stage folder, so it never edits the stages Claude Code runs.

### Models

Each stage runs on its own model, set by the file's `model` key and Claude Code's `effort` key for the
reasoning effort. The Stages section shows them as a table of stage, model and effort, so the whole
pipeline's choice reads at a glance, for example Sonnet for Triage, Fable for Plan and Review and Opus for the
rest. A model is picked from the models the agent backend offers, by alias or exact id.

- An item can override a stage's model for its next run, such as a hard bug planned on a stronger
  model; the run records the model it used.
- Review warns when its model is the one Implement's last run used, since the
  [review guideline](https://x-tech-laboratories.github.io/guidelines/review/) asks for a second model.
- The Runs page sums tokens and cost by stage and model, so a costly choice shows.

## The agent backend

A run is given X-Dev's run tools, limited to the item being run, for `ask_user`, `get_item_status`,
`update_item_status` and `propose_item`, called with curl as set out below.

Agent backends are provider plugins (`agent_backend`). The bundled one runs Claude Code:

```
claude -p --agents <run>/agents.json --agent stage-<id> --session-id <uuid> --output-format stream-json
  --verbose --permission-mode auto
```

in the item's worktree, with the input on standard input, through X-Libs' `run_program` (no shell,
its own process group, stopped by an abort signal). It runs on the user's own Claude login.

- The stage goes in as a JSON agent definition (`--agents`), so it runs from whichever folder holds
  the stage files; Claude Code honours its model, effort, tools and refused tools from there, and a
  model given for one run replaces the stage's in that file.
- The session id is X-Dev's own, so a run waiting for answers resumes with `--resume <uuid>` and the
  answers on standard input.
- Where a managed MCP config is present, Claude Code refuses both `--strict-mcp-config` and
  `--mcp-config`, so X-Dev's run tools are not an MCP server: they are a small HTTP server on
  127.0.0.1 that the agent calls with curl, the address and the run's token in its environment
  (`X_DEV_RUN_URL`, `X_DEV_RUN_TOKEN`) and the way to call them added to every run's input.
- The stream's last message is `{"type": "result"}` with the final text, `is_error`,
  `total_cost_usd` and the session id; the report block is read from that text.
- The permission mode is a setting, `auto` unless set, so every action is checked with no one
  watching.

This is a written exception to "a daemon never shells out": Claude Code has no Node API that uses the
user's login, and `git worktree` has none either. GitHub is reached through the `gh` program the user
is signed into, so X-Dev never reads, stores or passes on a GitHub token. All three are named in the
README.

Other backends, such as OpenCode, can be added as plugins later.

## GitHub

- An item is made from an issue, or makes one: an item saved without an issue number, or a proposal
  taken from the inbox, is linked to the open issue whose title matches it closely, or opens a new
  issue with its title and body. Its stage is mirrored as a `stage:*` label, and
  `stage:needs-input` marks open questions; X-Dev creates missing labels and never edits others.
- Each report is posted as a comment starting with `<!-- stage-handoff -->`; an edited report edits
  its comment, and a discarded run's comment is marked as discarded rather than deleted, so the
  thread keeps its order and the notice already sent still leads somewhere. A gate's override
  reason is part of the report, so it goes with it.
- The status sheet is kept at the top of the issue's body between `<!-- x-dev-status -->` markers;
  the rest of the body is left exactly as it was.
- The issue is closed once the item has been through Close, unless it is closed already.
- Review opens the pull request with `Closes #<n>`. X-Dev finds it from the item's branch after each
  run and keeps its state and checks; the item page shows them. `CyclePoller` looks again every half
  minute while checks run and every five minutes otherwise; GitHub's webhooks through
  `server/forge_webhook` are still to come.
- Every write goes through `gh` after the run has ended and never fails it: what went wrong is kept
  on the item and shown there, and the next run, the next poll or **Sync to GitHub** tries again.
  Reports and the sheet pass the `secrets` check first and are held back when they fail it.
- In `x-tech-laboratories` repositories, commits carry `Assisted-by: Claude Code` and the pull request
  says which parts AI wrote.

## Pages

- **Board**: a column per stage and a card per item in its stage's column; the card merges the item
  and that stage's run. It names the repository and issue and the item, then the run's state, the
  first line of its report or what failed, its model, changed lines, cost and age, its gates, a
  waiting run's question with its choices, the pull request and its checks, and, once it has runs, a
  dot per stage for the way the item came. It holds Run with a model picker, and a menu to open the
  item, send it back to an earlier stage and discard its last run. Clicking a card, or Enter on it,
  opens the item at that run; dragging it to an earlier column, or Alt and Left, sends it back after
  a confirm, and no later column takes a dragged card, since stages move on only by a run's report.
  Cards filter by repository and words, can be grouped into a lane per repository, and finished
  items show in a Done column when asked; on a phone the columns stack. The Inbox above holds the
  proposals waiting for the user, one line each, and is just its heading when empty. The board is
  the page X-Dev opens on and fills the window, scrolling inside itself with its column heads in
  view. X-Dev draws it with X-Libs' `Board` widget; the card (`src/web/board/ItemCard.tsx`) draws
  only what goes inside the widget's card.
- **New item**: two ways in, side by side. **Describe it** takes free text, such as a pasted bug report
  or a few lines of an idea, and an agent fills in the form from it: title, feature or bug, the
  repository it guesses from the text and the repositories X-Dev knows, a body for the issue, and,
  for a repository X-Dev has no checkout of, the checkout it finds by searching the filesystem with
  read-only tools. X-Dev checks that folder's git remote, searches beside the known checkouts itself
  when the agent found none, and adds the checkout to Repositories when the item is saved. The filled form opens for the user to check and change before anything is saved. **Fill in
  the form** opens the same form empty. The agent's run is short and cheap (a setting picks its
  model, Haiku unless set), and it changes nothing until the user saves.
- **Item**: the issue and its status sheet, then the runs as a timeline, each with its report (editable), its output and
  its cost; the branch's diff; the pull request and its checks; notes for the next run.
- **Runs**: every run across items in a table of item, stage, model, state, start, duration, tokens,
  cost and gates, filtered by words and state, a row opening its item at that run; above it the tokens
  and cost summed by stage and by model.
- **Repositories**: each repository with its checkout on this computer and its open items, added by
  choosing the checkout's folder, its owner/name read from its git remote. They are a list of what
  X-Dev works on, like X-Backups' repositories, so they have a page of their own rather than a
  section of Settings.
- **History**, and **Settings** with Stages, GitHub (signing `gh` in and out) and Runs, then the standard
  Sync, Backups, Notifications, Import and export, Plugins, Users and Tokens.

Notifications: a run finished, failed, asked questions or made proposals; a pull request's checks
finished.

## Platforms and daemon

A personal app, as the Application Standard sets out for X-Tasks: a local daemon ("This computer")
on the machine that holds the repositories and the Claude login, with the desktop, web and Android
apps as UIs onto it. Android and other computers connect to it as a remote daemon. Items, runs and
reports sync; worktrees and stage files stay on the machine that runs the agents.

## Built from X-Libs

| Need | X-Libs |
| ---- | ------ |
| Daemon and window, socket, autostart, tray, connections | `local_daemon`, `autostart`, `electron/*`, `connections`, `daemon_link`, `server/call_table` |
| Store, migrations, history, sync, backups | `sql`, `drizzle`, `history`, `sync_engine`, `sync_client`, `server/sync_routes`, `server/sqlite_backups` |
| API, OpenAPI, MCP | `api_spec`, `server/mcp`, `electron/mcp` |
| Accounts | `server/account_store`, `server/account_sign_in`, `web/react/sign_in`, `web/react/accounts` |
| Running the agent | `agent/programs` (`run_program`), `agent/long_runs` for runs that outlive a restart |
| Following a run | `server/events`, `server/runs`, `web/react/following`, `web/react/outcome_log` |
| Stage file fields | `web/react/chip_field`, `web/react/suggestions` |
| GitHub events | `server/forge_webhook`, `server/poller` |
| Notifications | `agent/desktop_notify`, `server/notify/*`, `phone_notices` |
| Lane grouping and filters | `grouping` (`group_items`), `filter`, `FilterStack` |
| Reports | `web/react/markdown` |
| Runs table, cost charts | `DataTable`, `web/react/charts` |
| Pages and widgets | `Shell`, layout, dialogs, `PageView`, `SettingsPage`, toasts, menus, `Icon`, `Board` |
| Plugins | `plugins`, `web/react/plugins` |
| Change checks and `x-dev-check` | `change_checks`, `change_checks_git` (`read_change`), `change_checks_cli` (`run_check_command`) |

Missing from X-Libs, to be built there rather than in X-Dev:

- A diff view: a branch's changes by file, with added and removed lines. X-Dev's is built app-local in
  `src/web/diff/` and `src/shared/diff/`, on parse-diff, with nothing of X-Dev in its props, ready to move.
- A GitHub client on Octokit: issues, labels, comments, pull requests and checks, for any app.
- Git worktrees: make, list, reset and remove one, through `run_program`.
- Markdown files with frontmatter: read and write them, keeping keys the app does not know.

## Milestones

1. **Skeleton**: the app from the standard's checklist, with the daemon, store, Shell, Settings and CI,
   on X-Libs.
2. **Stages**: reading and editing the stage files.
3. **Runs**: items by hand or described in free text for an agent to fill in, running a stage through
   Claude Code, reports, discard, questions, the status sheet tools and proposals; no GitHub yet.
4. **Gates**: the gates and `x-dev-check`, then the change checks moved into X-Libs.
5. **GitHub**: issues, labels, comments, pull requests and checks.
6. **Board and item pages**, the diff view, notifications.
7. **Android and remote daemons**.

## Checked for milestone 5

- The labels, comments, body, closing, pull request and checks are tested against a stand-in for
  `gh` that keeps a fake GitHub in a file, not against GitHub itself; the `gh` arguments and JSON
  fields follow gh's manual.

## Checked for milestone 3

- Claude Code reads an agent file with the `x-dev-*` keys and ignores them, taking its model from the
  file (checked with Claude Code 2.1.328).
- `ask_user` records the questions and tells the agent to end its turn; once the session ends with
  questions recorded, the run waits, and answering resumes the same session.
- X-Dev's run tools are reached over HTTP with curl, each run reaching only its item through its token;
  checked with a real Claude Code run under the `auto` permission mode.
