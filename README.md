# X-Dev

<a href="https://liberapay.com/BeatLink/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a> <a href="https://ko-fi.com/I4V52ANK6N"><img alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a>

X-Dev takes features and bug fixes through a fixed set of stages, such as plan, implement, review and deploy, one AI
coding agent run per stage. You start each stage yourself; each run sees only what its stage needs and ends by saving a
report for the next one. [docs/design.md](docs/design.md) sets out the whole design.

It runs as a web page served by your own server, as a desktop app and as an Android app; the desktop and Android apps
keep their own copy of the data, work offline, and sync with the server whenever it can be reached.

What it does so far:

- **Board:** the page X-Dev opens on. A swimlane for each open item, grouped by repository, and a column for each
  stage; each cell shows that stage's latest run on the item with a line from its report, earlier stages it went past
  without a run as skipped, and the stage the item is at marked, with Run. The inbox of proposals sits above the lanes;
  lanes filter by repository and words, and finished items fold away unless shown.
- **Items:** each feature or bug fix in one GitHub repository, with its issue, the stage it is at, and a status sheet
  that every stage reads and keeps current. Items are added, edited, closed and reopened on the Items page.
- **Stages:** the steps every item goes through, from Triage to Close, each a Claude Code agent file with its own
  model, effort, next stage, gates, tools and prompt. **Settings → Pipeline → Stages** lists them in order, edits each
  in a dialog, moves and deletes them, and adds the default stages where they are missing.
- **Runs:** each item's page starts its current stage, or any other, on the stage's model or one picked for that run.
  The run works in the item's own git worktree as a headless Claude Code session, one run at a time, and ends with a
  report the next run starts from. A run can ask you questions and wait, update the item's status sheet, and propose
  new items into the Inbox. Every run keeps its transcript, cost and report; the latest can be stopped or discarded,
  which puts the worktree, the status sheet and the stage back as they were.
- **Gates:** once a run hands in its report, X-Dev checks the change itself, by the gates the stage file names: the
  report and status sheet, the main checkout left alone, only allowed paths changed, Specify's tests failing first and
  kept after, tests, types and lint, the coverage floor, Conventional Commits and their trailer, no secrets, no
  leftovers, one-line comments, file size, libraries X-Libs wraps, and new dependencies' licences. A failed gate holds
  the item until the stage runs again or you pass the gate over with a reason, which the next stage reads.
- **Repositories:** a page of the repositories X-Dev works on, each with its checkout on this computer and its open
  items. A checkout is added by choosing its folder; its owner/name is read from its git remote.
- **New items:** described in a few lines for an agent to fill the form in from, or filled in by hand. The describing
  agent also looks for the repository's checkout on this computer when X-Dev does not know it yet; X-Dev checks the
  folder's git remote, looks beside the known checkouts itself when the agent found none, and adds the checkout to
  Repositories when the item is saved. An item saved without an issue number, or a proposal taken from the inbox, is
  linked to the open issue that matches its title, or gets a new issue with its title and body.

## Running it

```sh
nix-shell                 # Node 24 and an Electron that runs on NixOS
npm install
npm run hash-password -- admin password.hash  # an admin in password.hash, which the dev server reads
npm run dev:server        # the server on http://127.0.0.1:7760, with the data in dev-data/
npm run dev:web           # the page with live reload, reaching that server
npm run dev               # the desktop app, with its profile in dev-data/desktop
```

`npm run build` type-checks and builds the page into `out/web`; `npm start` serves it. `npm run build:desktop` builds
the desktop app into `out/`, and `npm run build:android` builds the phone's page and copies it into `android/`
(build the app itself in `nix develop .#android` with `cd android && ./gradlew assembleDebug`).

## Configuration

The server reads a JSON file named by `X_DEV_CONFIG`; `config.example.json` is the complete default:

| Field            | Means                                                     |
| ---------------- | --------------------------------------------------------- |
| `database`       | the SQLite file, made if missing                          |
| `backups_folder` | where the server's backups are kept                       |
| `stages_folder`  | the stage files, `~/.claude/agents` in the server's home unless set |

The address and port come from `X_DEV_HOST` and `X_DEV_PORT` (or `--host` and `--port`), 127.0.0.1:7760 unless
set. The admins are read from the accounts file `X_DEV_PASSWORD_HASH_FILE` names, one `name:hash` line each;
`npm run hash-password -- <name> <file>` adds one or changes their password. `x-dev --help` lists every option.

## Stages

A stage is a file named `stage-<id>.md`, such as `stage-plan.md`, in Claude Code's agents folder, `~/.claude/agents`, so
Claude Code in a terminal and X-Dev run the same stages. Its frontmatter holds Claude Code's own keys (`name`,
`description`, `model`, `effort`, `tools`, `disallowedTools`) and X-Dev's (`x-dev-label`, `x-dev-order`, `x-dev-next`,
`x-dev-gates`, `x-dev-paths`, `x-dev-max-proposals`); the rest of the file is the prompt. X-Dev keeps every other key and comment when it
writes a file back, and shows a change made in an editor at once. A file it cannot read is listed with why, and never
overwritten.

The desktop app reads the stages through its daemon; the web server reads `stages_folder`, and only an admin may change
them. A dev run (`npm run dev`, `npm run dev:server`) keeps its own stages under `dev-data/`.

## Runs

Runs start from the desktop app, whose daemon holds the checkouts. On the **Repositories** page choose each checkout's
folder, or type it in a browser; an item's first run makes its worktree there, at
`.claude/worktrees/item-<issue or id>` on the branch `worktree-item-<issue or id>`, from the latest default branch.
**Settings → Pipeline → Runs** sets how the agents' actions are approved (auto, checking each one, unless set), the
`claude` program, and the small model that fills in described items.

Each run is `claude -p` with the stage as its agent and the run's input on standard input. Its X-Dev tools, `ask_user`,
`get_item_status`, `update_item_status` and `propose_item`, reach only its item: they are a small HTTP server on
127.0.0.1 that the agent calls with curl, the address and the run's token in its environment, since Claude Code refuses
a run's own MCP servers where a managed MCP config is present. A run's agent definition is kept in the profile folder
under `runs/`. Runs are not versioned in History;
their transcripts and reports are kept with them.

X-Dev starts `claude`, `git` and `gh` as programs, an exception to the Application Standard's rule that a daemon does
not shell out: Claude Code has no Node API that runs on the user's own login, Node has no API for git worktrees, and
going through the `gh` you are signed into means X-Dev never reads, stores or passes on a GitHub token. Sign `gh` in
from **Settings → Pipeline → GitHub**, which starts `gh`'s sign-in in the browser and shows the one-time code to enter
on GitHub's device page, or with `gh auth login`; **Settings → Pipeline → Runs** names another `gh` if needed. Signing
out there signs `gh` out on this computer, for every program that uses it.

## Gates and x-dev-check

The gates X-Dev runs after a stage are also a command, so a repository's CI holds every change to them, whether X-Dev
made it or not:

```sh
npx x-dev-check                     # the gates that need only the change, against the branch point from origin/main
npx x-dev-check --base origin/main commits secrets leftovers
```

It prints each gate's result and findings and exits with 1 when any fails. X-Dev's own CI runs it on every pull
request. A gate that cannot check a repository, such as `tests-pass` where there is no vitest, says so as not checked
rather than passing; `ci` waits until X-Dev tracks pull requests.

## The desktop app in the background

The desktop app runs as two processes: a daemon that holds the data and does the work, and the window that shows it.
Closing the window leaves sync, backups and the MCP server running, and the window opens again straight onto the data.
A tray icon shows how many items are open and brings the window back; **Quit completely** there or under
**Settings → Desktop** stops the daemon too. The app opens `x-dev://<page>` links, such as `x-dev://items`.

**Settings → Desktop** turns off the tray icon, keeping running in the background, and starting at login, which runs
`x-dev-desktop --daemon` without opening the window. These belong to the computer and are never synced. The
daemon's log is `~/.local/state/x-dev/daemon.log`.

X-Dev has no notifications yet; runs that finish or ask questions will notify once runs exist.

## Signing in

A browser signs in with a name and password, the X-Libs accounts every X-app shares. Unless "Keep me signed in" is
ticked, the session ends when the browser closes; ticked, it lasts until it is signed out from **Your account**. There
each user changes their password, turns on a second factor, sees where they are signed in and makes tokens; an admin
adds users on **Users**.

## Sync

In the desktop or Android app, open **Settings → This device → Sync**, enter the server's address, your name and
password, and choose whether this device starts from the server's data or the server from this device's. The copy that
loses is backed up first. After that, changes go both ways within seconds, and a device that is offline catches up once
it is back. The device gets a token of its own, listed on **Your account**, which Stop syncing gives back.

## Backups

Every copy of the data backs itself up: daily by default, keeping the last 14, and always before a restore, before a
sync takes the other copy, and before an upgrade changes the database. **Settings → Backups** takes one by hand, sets
the schedule and lists every backup to restore or delete; backups taken by hand are kept until deleted. The schedule
belongs to that device or server and is never synced.

- **Desktop:** in `backups/` beside the database in the profile folder. A restore backs up the current data first and
  stops sync, so you choose again which copy wins.
- **Android:** in a folder you pick once under **Settings → Backups → Backup folder**, such as Documents, where file
  managers and sync apps reach them. Until one is picked there are none, and daily backups wait. A restore backs up the
  current data first and stops sync.
- **Server:** in `backups_folder`. Only an admin sees them. A restore from the page backs up the current data first,
  then the server stops and its service starts it again on the backup; every device then chooses which copy wins.

## History

Every change to an item, its stage and status sheet included, is kept as a version, whichever device, page, API call or
MCP tool made it. **History** in the sidebar lists the latest changes, and **History** beside an item lists its versions:
any version can be restored, and a deleted item brought back. Versions sync, so every device sees the same history.
Changes older than **Settings → General → History** (180 days unless set) are pruned, each item keeping its latest.

## Other programs: the API and MCP

Every call the page makes is open to other programs on the server, behind a token made on **Your account** and sent as
`Authorization: Bearer <token>`:

- **API:** `POST /api/call/<method>` with the arguments as a JSON list in order, or by name as a JSON object.
  `GET /api/openapi.json` describes every call.
- **MCP:** `/api/mcp` serves every call as a tool over streamable HTTP, the calls that only read marked read-only. To
  add it to Claude Code:

  ```sh
  claude mcp add --transport http x-dev https://<server>/api/mcp --header "Authorization: Bearer <token>"
  ```

The desktop app can serve the same MCP tools itself, on its own data and with no server or token: turn on **Settings →
MCP server**, and while its daemon runs it listens on `http://127.0.0.1:3921/mcp` (the port is set there too), reachable
only from the same computer:

```sh
claude mcp add --transport http x-dev http://127.0.0.1:3921/mcp
```

A change made through either reaches every open page and device as if made there.

## NixOS

```nix
inputs.x-dev.url = "github:x-tech-laboratories/X-Dev";

imports = [ x-dev.nixosModules.default ];
services.x-dev = {
  enable = true;
  passwordHashFile = "/etc/x-dev/password-hash";
};
```

`packages.default` is the server and `packages.desktop` the desktop app.

## Layout

```
src/
  server/    Fastify app and main.ts, and the calls it shares with the daemon
  daemon/    the desktop app's daemon: its database, the page's calls, sync, backups and MCP, on a Unix socket
  main/      Electron main process: the window, the tray icon and the login entry, passing calls to the daemon
  preload/   the desktop page's bridge
  web/       the React page, one folder per feature, and hosts/ for web, desktop and Android
  shared/    the store every host runs, one folder per feature, and the bridge's method tables
tests/       one *.test.ts per behaviour
docs/        design.md and architecture.md
android/     the Capacitor project
nix/         package.nix, desktop-package.nix, module.nix
```

## License

GPL-3.0-or-later.
