# X-Dev

<a href="https://liberapay.com/BeatLink/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a> <a href="https://ko-fi.com/I4V52ANK6N"><img alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a>

X-Dev takes features and bug fixes through a fixed set of stages, such as plan, implement, review and deploy, one AI
coding agent run per stage. You start each stage yourself; each run sees only what its stage needs and ends by saving a
report for the next one. [docs/design.md](docs/design.md) sets out the whole design.

It runs as a desktop app whose daemon, "This computer", holds the checkouts and the Claude login and runs the agents.
That daemon can let other devices connect: a browser, the Android app and the desktop app on another computer then work
on it as a remote daemon, signed in as an admin, and can start and answer runs there. It also runs as a web server, and
the desktop app's data syncs with a server, so items, runs and reports are alike everywhere while worktrees and stage
files stay on the computer that runs the agents.

What it does so far:

- **Items page:** the page X-Dev opens on, showing the items as a board or as a list, switched by **Board | List** in its
  toolbar; the choice is kept on each device, and `#/items/board` and `#/items/list` name a view. Both views share
  the toolbar (Add Item, search, the repository filter, Show finished items, Group by repository) and the inbox of
  proposals above them, and the filters stay when switching. The list is a table of each item's title, kind,
  repository, issue and stage, with edit, history, close or reopen and delete on each row, grouped under a heading
  per repository when asked. The board is a kanban board on X-Libs' `Board` with a column for each stage and a card
  for each open item in the column of the stage it is at. The card shows the latest run of that stage: its state, the first line of its report
  or what failed, its model, the lines it changed, its cost, its age and its gates, a waiting run's question with its
  choices, the item's pull request and checks, and, once it has runs, a dot for each stage the item went through. Clicking a card or pressing Enter on it opens the
  item. Run starts the stage, on
  the stage's model or one picked for that run; the card's menu opens the item, sends it back to an earlier stage and
  discards its last run. Dragging a card to an earlier column, or Alt and Left on it, sends the item back there after a
  confirm. The board fills the window under its toolbar and the inbox of proposals, scrolling inside itself with the
  column heads in view; cards filter by repository and words, group into a lane per repository, and finished items
  show in a Done column when asked. Closed items stay off the board; Show finished items lists them in the list view.
  On a phone the columns stack into a list of stages.
- **Items:** each feature or bug fix in one GitHub repository, with its issue, the stage it is at, and a status sheet
  that every stage reads and keeps current. Items are added, edited, closed and reopened on the Items page.
- **Stages:** the steps every item goes through, from Triage to Close, each a Claude Code agent file with its own
  model, effort, next stage, gates, tools and prompt. **Settings → Pipeline → Stages** lists them in order, edits each
  in a dialog, moves and deletes them, and adds the default stages where they are missing.
- **Runs:** each item's page and its card on the board start its current stage, or any other, on the stage's model or
  one picked for that run; Review warns when its model is the one Implement's last run used.
  The run works in the item's own git worktree as a headless Claude Code session, one run at a time, and ends with a
  report the next run starts from. A run can ask you questions and wait, update the item's status sheet, and propose
  new items into the Inbox. A run shows live on its item's page, and in a dialog from its card: the agent's thinking,
  its text and each tool call with its input and result, an edit as a small diff, with its state, model, time, tokens
  and cost. While it runs you can write to it, which the agent reads after its current step and which goes into the
  status sheet's Decisions; **Interrupt** halts the current step and leaves the session waiting for your message, and
  **Stop** ends the run. Every run keeps its transcript, tokens, cost and report; the latest can be discarded, which
  puts the worktree, the status sheet and the stage back as they were. A run that failed or was stopped offers
  **Retry**, which runs the stage again on the worktree as it was left and tells the agent how the last attempt ended,
  or **Retry from Clean**, which discards the run first. The **Runs** page lists every
  run across items, filtered by words and state, under their tokens and cost summed by stage and by model; a row opens
  its item at that run. The item's page shows its branch's changes since its work started, file by file.
- **Gates:** once a run hands in its report, X-Dev checks the change itself, by the gates the stage file names: the
  report and status sheet, the main checkout left alone, only allowed paths changed, Specify's tests failing first and
  kept after, tests, types and lint, the coverage floor, Conventional Commits and their trailer, no secrets, no
  leftovers, one-line comments, file size, libraries X-Libs wraps, and new dependencies' licences. The checks every
  X-app shares (commits, secrets, leftovers, comments, coverage, X-Libs imports, dependencies) are X-Libs' change checks;
  the rest are X-Dev's own. A failed gate holds the item until the stage runs again or you pass the gate over with a
  reason, which the next stage reads.
- **Repositories:** a page of the repositories X-Dev works on, each with its checkout on this computer and its open
  items. A checkout is added by choosing its folder; its owner/name is read from its git remote.
- **New items:** described in a few lines for an agent to fill the form in from, or filled in by hand. The describing
  agent also looks for the repository's checkout on this computer when X-Dev does not know it yet; X-Dev checks the
  folder's git remote, looks beside the known checkouts itself when the agent found none, and adds the checkout to
  Repositories when the item is saved. An item saved without an issue number, or a proposal taken from the inbox, is
  linked to the open issue that matches its title, or gets a new issue with its title and body.
- **GitHub:** once a run ends, the desktop app mirrors the item to its issue through `gh`: a `stage:<id>` label for the
  stage it is at, `stage:needs-input` while a run waits on you, each report as a comment starting with
  `<!-- stage-handoff -->` (edited when the report is, marked when the run is discarded), the status sheet at the top of
  the issue's body between `<!-- x-dev-status -->` markers, and the issue closed once the item is through Close. It
  finds the pull request Review opens from the item's branch and shows it with its checks on the item page, looking
  again every half minute while checks run. Nothing that fails here fails a run: the item page shows what went wrong,
  and the next run, the next look or **Sync to GitHub** tries again. Reports and sheets that hold a secret are not
  posted.

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
(build the app itself in `nix develop .#android` with `cd android && ./gradlew assembleDebug`; CI builds the same debug
package on every pull request). The phone keeps no data of its own: it works on the daemon it connects to.

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

Runs start on the daemon that holds the checkouts: from its own desktop app, or from any device connected to it (see
[Other devices](#other-devices)). On the **Repositories** page choose each checkout's folder, or type its path from a
browser, a phone or a window connected from another computer; an item's first run makes its worktree there, at
`.claude/worktrees/item-<issue or id>` on the branch `worktree-item-<issue or id>`, from the latest default branch.
**Settings → Pipeline → Runs** sets how the agents' actions are approved (auto, checking each one, unless set), the
`claude` program, and the small model that fills in described items.

Each run is `claude -p` with the stage as its agent, talking stream-json both ways: the run's input is its first message,
your messages are written in as it runs, and its stream becomes the transcript. Its X-Dev tools, `ask_user`,
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
npx x-dev-check --working-tree      # uncommitted and untracked files count too
```

It is X-Libs' `x-libs-check` with X-Dev's own gates added, so it takes the same options and the same `"x-libs-check"`
settings in `package.json`. It prints each gate's result and findings and exits with 1 when any fails, or 2 when a
gate is not known. X-Dev's own CI runs it on every pull
request. A gate that cannot check a repository, such as `tests-pass` where there is no vitest, says so as not checked
rather than passing. `ci` reads the pull request's checks through `gh`, so only the desktop app's runs check it: checks
still running hold the item, and it moves on by itself once they pass.

## The desktop app in the background

The desktop app runs as two processes: a daemon that holds the data and does the work, and the window that shows it.
Closing the window leaves sync, backups and the MCP server running, and the window opens again straight onto the data.
A tray icon shows how many items are open and brings the window back; **Quit completely** there or under
**Settings → Desktop** stops the daemon too. The app opens `x-dev://<page>` links, such as `x-dev://items`.

**Settings → Desktop** turns off the tray icon, keeping running in the background, and starting at login, which runs
`x-dev-desktop --daemon` without opening the window. These belong to the computer and are never synced. The
daemon's log is `~/.local/state/x-dev/daemon.log`.

The daemon tells you, through desktop notifications, when a run finishes, fails, asks questions or makes proposals,
and when the checks on an item's pull request finish; clicking one opens the item. **Settings → Notifications** turns
each kind on or off for this computer. A window connected to another computer's daemon shows that daemon's notices
itself, by the same switches. The Android app shows them while it is open or in the background, since a phone has no
daemon of its own; once Android has closed it, nothing arrives until it opens again. A browser shows none.

## Other devices

**Settings → This device → Other devices**, in the desktop app on the computer that holds the checkouts, turns on
**Let other devices connect**: the daemon then also listens on the address and port given there (0.0.0.0:7760 unless
set), behind the same sign-in as the web server, and serves the page to a browser. Add an admin there first, with a
name and a password of at least 10 characters; they are kept hashed in `remote-admins` in the profile folder, readable
by you alone, and an admin can add other users on **Users**. Give a certificate and key file to serve https; without
them the daemon speaks plain http, which only a VPN or an https reverse proxy in front should carry, and the Android app
refuses plain http to anything but itself.

Another computer's desktop app, or the Android app, adds the daemon under **Settings → Connections** with its address
and an admin's name and password, which gives the device a token of its own, listed on **Your account**; the desktop
app then switches between This computer and the daemons it knows there, and opens on the one it used last. A device
signed in as an admin can do everything the computer's own window does: see the board, items, runs and reports live,
add and describe items, start a run, answer a waiting run, send an item back, discard a run, take or drop proposals,
edit stage files, and add checkouts by typing their path. It cannot change which `claude` and `gh` programs the daemon
starts or how freely their actions are approved, which change only on that computer; signing `gh` in from elsewhere
gives the code to enter on GitHub's device page from that device. A user who is not an admin sees and edits items but
starts no runs and changes no stages. Its MCP endpoint offers the same, as [Other programs](#other-programs-the-api-and-mcp) sets out.

A run started on one computer is answered, stopped and discarded only through the daemon that started it, which holds
its worktree and session; a copy that synced the run says so when asked.

## Signing in

A browser signs in with a name and password, the X-Libs accounts every X-app shares. Unless "Keep me signed in" is
ticked, the session ends when the browser closes; ticked, it lasts until it is signed out from **Your account**. There
each user changes their password, turns on a second factor, sees where they are signed in and makes tokens; an admin
adds users on **Users**.

## Sync

In the desktop app, open **Settings → This device → Sync**, enter the server's address, your name and
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
- **Another computer's daemon:** an admin connected to it sees and takes its backups as on that computer.
- **Server:** in `backups_folder`. Only an admin sees them. A restore from the page backs up the current data first,
  then the server stops and its service starts it again on the backup; every device then chooses which copy wins.

## History

Every change to an item, its stage and status sheet included, is kept as a version, whichever device, page, API call or
MCP tool made it. **History**, the last row of the sidebar's list, lists the latest changes, and **History** beside an item lists its versions:
any version can be restored, and a deleted item brought back. Versions sync, so every device sees the same history.
Changes older than **Settings → General → History** (180 days unless set) are pruned, each item keeping its latest.

## Other programs: the API and MCP

Every control of the page is open to other programs, such as another Claude Code session, on the server and on a desktop
daemon that lets other devices connect, behind a token made on **Your account** and sent as
`Authorization: Bearer <token>`:

- **API:** `POST /api/call/<method>` for the data, `/api/stages/<method>` for the stage files and `/api/runner/<method>`
  for runs, checkouts and GitHub, with the arguments as a JSON list in order; the data calls also take them by name as a
  JSON object. `GET /api/openapi.json` describes every call.
- **MCP:** `/api/mcp` serves every call as a tool over streamable HTTP, the calls that only read marked read-only. A
  session adds an item with `add_item`, which also adds a checkout given by its path and finds or opens the GitHub issue,
  as the New item form does; `describe_item` turns a rough note into a draft for it first. The tools that start or undo
  an agent's work (`start_run`, `answer_run`, `discard_run`) or change the computer that runs the agents (`add_repository`,
  `save_stage` and the other stage tools) say so in their descriptions.

What a token reaches is what its user reaches: an admin's every tool, another user's the data tools alone (adding,
editing and closing items with `save_item`, but no runs, stages, checkouts or GitHub), and a token made read-only on
**Your account** only the tools that read. Tokens have no narrower scope, such as adding items only. Wherever
it is reached from, the runner refuses to change `claude_program`, `gh_program` or the permission mode, which change
only in X-Dev's own window on the computer that runs the agents.

To add the server to Claude Code:

```sh
claude mcp add --transport http x-dev https://<server>/api/mcp --header "Authorization: Bearer <token>"
```

The desktop app can serve the same tools itself, on its own data and with no token: turn on **Settings → MCP server**,
and while its daemon runs it listens on `http://127.0.0.1:3921/mcp` (the port is set there too), reachable only from
the same computer. Every program on this computer can then start agent runs through it, so leave it off on a computer
other people sign in to.

```sh
claude mcp add --transport http x-dev http://127.0.0.1:3921/mcp
```

On a computer with a managed MCP config (`/etc/claude-code/managed-mcp.json`), Claude Code refuses `claude mcp add`;
add the server to that file instead, under `mcpServers`, with the same `type`, `url` and `headers`.

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
