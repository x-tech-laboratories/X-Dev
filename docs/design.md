# X-Dev design

X-Dev takes a feature or a bug fix through a fixed set of stages, one stage at a time, each run by an
AI coding agent that sees only what that stage needs. The user starts every stage by hand. A stage is
atomic: it ends by saving a report, and the next stage starts from that report and nothing else.

## Words

- **Item**: one feature or bug fix in one repository, linked to its GitHub issue, with its own git
  worktree and branch.
- **Stage**: one step of the work, defined in a file (see [Stage files](#stage-files)). The default
  stages are Plan, Implement, Extract, Docs, Review and Deploy.
- **Run**: one stage run on one item. It keeps the input it was given, the commit it started from,
  the agent's output, the report, the tokens it used and how it ended.
- **Report**: what a run hands to the next stage. It is the only thing a stage passes on.

## The default stages

| Stage     | Does                                                                                   | Can edit |
| --------- | -------------------------------------------------------------------------------------- | -------- |
| Plan      | Reads the issue and the code, checks X-Libs and Halon for reuse, writes the plan, asks questions | no |
| Implement | Writes the code and its tests in the item's worktree, raises the coverage floor        | yes      |
| Extract   | Moves what other apps could use into X-Libs or Halon, or adds it to X-Libs' TODO        | yes      |
| Docs      | Brings the README, docs, comments and screenshots in line with the change              | yes      |
| Review    | Checks code, docs and UI against the standards; pushes and opens the pull request when it passes, or sends the item back | no |
| Deploy    | After the user merges, follows the release and deploys to TechNet through X-Nix        | no code  |

Tracking is not a stage: the item and its GitHub issue are the record every stage reads and writes.

## How a stage runs

1. The user presses **Run** for the item's current stage, or picks another stage to send it back to.
2. The daemon builds the input: the issue's title and body, the latest report, and the notes the user
   added since. Earlier reports and runs are left out.
3. It runs the stage's agent in the item's worktree, one run at a time across the whole app, and
   streams the output to the page.
4. The agent ends with a report block (below). The daemon saves it, posts it to the issue as a
   comment and moves the issue's `stage:*` label.
5. The user reads the report and can edit it before the next stage reads it. Questions the stage
   asked are answered on the item and go to the next run as notes.
6. **Discard** drops a run: its report is removed and the worktree is reset to the commit the run
   started from. Stages before Review commit but never push, so a discard never needs a force-push.

A run that fails, is stopped or loses its daemon ends as failed, keeps its output, and changes
nothing else; the user discards it or runs the stage again.

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

## Stage files

Stages are Claude Code agent files in `~/.claude/agents/stage-<name>.md`, so the `/advance` command in
a terminal session and X-Dev run exactly the same stages. The frontmatter is Claude Code's (`name`,
`description`, `model`, `tools`, `disallowedTools`) plus X-Dev's own keys, which Claude Code ignores:

```yaml
x-dev-order: 2          # place in the pipeline
x-dev-next: extract     # the stage that normally follows
x-dev-label: Implement  # the name the page shows
```

The Stages section of Settings lists them in order and edits each one in a dialog: its name, model,
tools, next stage and prompt, the prompt in `RichText`. Saving writes the file back with its
frontmatter. The daemon watches the folder with `config_watch`, so a file edited in a text editor
shows at once. Stage files are the user's config, not synced data; the settings export carries them.

## The agent backend

Agent backends are provider plugins (`agent_backend`). The bundled one runs Claude Code:

```
claude -p --agent stage-<name> --output-format stream-json --verbose
```

in the item's worktree, with the input on standard input, through X-Libs' `run_program` (no shell,
its own process group, stopped by an abort signal). It runs on the user's own Claude login.

This is a written exception to "a daemon never shells out": Claude Code has no Node API that uses the
user's login, and `git worktree` has none either. Both are named in the README. GitHub is reached
through Octokit, not `gh`, with the token read from a file the config names.

Other backends, such as OpenCode, can be added as plugins later.

## GitHub

- An item is made from an issue, or makes one. Its stage is mirrored as a `stage:*` label, and
  `stage:needs-input` marks open questions; X-Dev creates missing labels and never edits others.
- Each report is posted as a comment starting with `<!-- stage-handoff -->`.
- Review opens the pull request with `Closes #<n>`. The item page shows the pull request and its
  checks, kept fresh by GitHub's webhooks through `server/forge_webhook` where the daemon is
  reachable, and by `CyclePoller` where it is not.
- In `x-tech-laboratories` repositories, commits carry `Assisted-by: Claude Code` and the pull request
  says which parts AI wrote.

## Pages

- **Board**: a swimlane per item and a column per stage. The lane's head names the item, its
  repository and issue; each cell shows that stage's runs for the item: done with a one-line summary
  of its report, running, failed, needs input, or not reached. The current stage's cell is marked and
  holds Run; any cell holds Send back here and, for its last run, Discard. Clicking a cell opens its
  report. Lanes are grouped by repository and can be filtered, and finished items fold away.
- **Item**: the issue, then the runs as a timeline, each with its report (editable), its output and
  its cost; the branch's diff; the pull request and its checks; notes for the next run.
- **Runs**: every run across items, for cost and failures.
- **History**, and **Settings** with Stages, Repositories, GitHub, Agent backend, then the standard
  Sync, Backups, Notifications, Import and export, Plugins, Users and Tokens.

Notifications: a run finished, failed or asked questions; a pull request's checks finished.

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
| Watching stage files | `config_watch` |
| GitHub events | `server/forge_webhook`, `server/poller` |
| Notifications | `agent/desktop_notify`, `server/notify/*`, `phone_notices` |
| Lane grouping and filters | `grouping` (`group_items`), `filter`, `FilterStack` |
| Reports and prompts | `web/react/markdown`, `web/react/rich_text` |
| Runs table, cost charts | `DataTable`, `web/react/charts` |
| Pages and widgets | `Shell`, layout, dialogs, `PageView`, `SettingsPage`, toasts, menus, `Icon` |
| Plugins | `plugins`, `web/react/plugins` |

Missing from X-Libs, to be built there rather than in X-Dev:

- A board widget with swimlanes: columns, optional rows (lanes) each with a head, and a cell per lane
  and column holding the app's cards, worked by keyboard and drawn as a lane list on phones. X-Tasks'
  `BoardView` is the starting point, moved into X-Libs with lanes added and X-Tasks switched onto it.
- A diff view: a branch's changes by file, with added and removed lines.
- A GitHub client on Octokit: issues, labels, comments, pull requests and checks, for any app.
- Git worktrees: make, list, reset and remove one, through `run_program`.
- Markdown files with frontmatter: read and write them, keeping keys the app does not know.

## Milestones

1. **Skeleton**: the app from the standard's checklist, with the daemon, store, Shell, Settings and CI,
   on X-Libs.
2. **Stages**: reading and editing the stage files.
3. **Runs**: items by hand, running a stage through Claude Code, reports, discard; no GitHub yet.
4. **GitHub**: issues, labels, comments, pull requests and checks.
5. **Board and item pages**, the diff view, notifications.
6. **Android and remote daemons**.

## To check before milestone 3

- The exact `claude` flags for running one agent headless with its tools and permission mode, and how
  `stream-json` marks the final message.
- That Claude Code ignores the `x-dev-*` frontmatter keys.
