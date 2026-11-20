# How X-Dev is put together

## One page, three hosts

The page in `src/web` is the same React tree everywhere. At start, `src/web/main.tsx` picks the host it runs on and hands
the page a `PageApi` (`src/shared/bridge.ts`):

| Host    | Where the data is                                   | How a call travels                                   | Sync                        |
| ------- | --------------------------------------------------- | ---------------------------------------------------- | --------------------------- |
| web     | the server's SQLite file                            | `POST api/call/<method>` with the arguments as JSON  | none; the browser is online |
| desktop | `dev.db` in Electron's profile folder               | IPC through the preload to the main process, then HTTP over the daemon's socket | X-Libs `sync_client` in the daemon |
| android | SQLite in WebAssembly, saved to IndexedDB           | straight to the store in the same page               | X-Libs `sync_client`        |

Views never ask which host they are on. They call `calls().<method>(...)` from `src/web/api.ts` and load with
`use_data`, which reloads quietly whenever `data_watch` is bumped: after this page writes, and when another page or
device changed something.

## The desktop daemon

The desktop app is a window and a daemon, as the Application Standard sets out. `src/daemon/main.ts` is plain Node on
Electron's own binary: it opens the database, runs sync, backups and the local MCP endpoint, and serves the same data
calls as the web server (`src/server/calls.ts`, the other tables through X-Libs `server/call_table`) over HTTP on `$XDG_RUNTIME_DIR/x-dev/daemon.sock`, with sync,
backups, certificates, MCP settings and its own settings under `/api/device`, `/api/certificates`, `/api/local_mcp` and
`/api/daemon`. `src/main/index.ts` starts it through X-Libs `local_daemon` unless one answers, passes the preload's calls
on to it, and hands its change events to the window. The main process keeps only the window, the tray icon
(X-Libs `electron/tray`, its menu worked out in `src/main/tray_menu.ts`) and the login entry through X-Libs `autostart`.

The tray, background running and start at login are kept in `desktop.json` beside the database, not in the synced
settings. Without "Keep running in the background" the daemon stops half a minute after its last window. A profile other
than the installed app's, such as `X_DEV_USER_DATA` in dev, gets a socket and log of its own and never writes the
login entry.

## Features

A feature is two folders:

- `src/shared/<feature>/store.ts` exports a `define_feature({ id, migrations, tables, methods, setting_defaults })`.
  - `migrations` run once each, in order, through X-Libs' `migrate` with the feature as owner, tracked in
    `schema_versions`. Every feature on Drizzle, such as Items, keeps its tables in `schema.ts`, and `npm run db:generate` writes
    each change as a migration under `migrations/` and bundles them into `migrations/index.ts`; a migration that only
    moves data is made with `npx drizzle-kit generate --config src/shared/<feature>/drizzle.config.ts --custom`.
  - `tables` lists the tables that sync, parents first, with the columns that name a row on every device; on Drizzle,
    `synced_tables(...)` reads them from the schema's primary keys. Rows need
    ids every device can make alone, such as `new_id()`; never an autoincrement key.
  - `methods` take the database first, then the page's arguments, and run synchronously or return a promise. A method
    that only reads is named `list_`, `get_`, `search_`, `lookup_` or `export_`.
  - `api` describes every method for other programs, in `src/shared/<feature>/api.ts`: what it does and a JSON Schema
    per argument, in order. A method without one fails to compile. The server serves them as MCP tools at `/api/mcp`,
    as `/api/openapi.json`, and lets `/api/call/<method>` take the arguments by name (X-Libs `api_spec` and
    `server/mcp`).
  - `after_write`, when given, runs after every write the page, API or MCP makes and before history records it.
  - `on_open`, when given, runs each time the database opens, after the migrations, for an upgrade SQL cannot do; it
    must change nothing the second time.
  - Settings keys are namespaced, such as `history.keep_days`, with their defaults in `setting_defaults`.
- `src/web/<feature>/index.tsx` exports its view, which gets the route's parts after `#/<feature>`, its pages, which the
  sidebar lists under the feature and the view picks by `#/<feature>/<page>`, and a function giving its sections for the
  Settings page.

The sidebar (`src/web/Sidebar.tsx`) is an X-Libs `Tree`: each feature folding open onto its pages, then History as the
last row, then Settings at the foot; a feature with one page is a single row. Items is the first feature and the page
the app opens on; `#/board` from before the board joined it opens `#/items/board`. A feature's `contained` and
`view_key` take the route's parts, so the items page's board and list keep the window still and share one view whose
state survives a switch, while an item's page does neither.

`src/shared/store.ts` and `src/web/features.tsx` list the features; nothing else knows them.

## Items

An item is one feature or bug fix in one GitHub repository (`src/shared/items/`): its title, kind, repository, issue
number, the stage it is at, and its status sheet, the short summary of where its work stands that every stage reads and
keeps current. The sheet is one JSON column with fixed sections (`status_sections` in `model.ts`), changed a section at a
time by `update_item_status`, which refuses a sheet over `status_limit` so it stays a summary. `docs/design.md` sets out
the stages, runs and gates still to come.

## Stages

Stages are files, not rows: `src/server/stage_files.ts` reads and writes the `stage-<id>.md` files in one folder with
the `yaml` package, so keys and comments it does not know survive, and watches the folder to announce changes made in
other programs. `src/shared/stages/model.ts` holds the fields and the rules the page shares, and
`src/server/default_stages.ts` the default stages. The daemon serves the calls under `/api/stages`, the main process
passes them on as the `x_dev_stages` bridge, and the web server serves them to admins only; a phone has none.

## Runs

A run is a row in `runs` (`src/shared/runs/`): the stage, its state, the model, the agent's session id, the commit and
status sheet it started from, its input, its transcript, its report and the stage that report names next, its
questions and answers, and its cost. `src/server/runner.ts` starts one at a time: it makes the item's worktree, writes
the stage as a JSON agent definition beside the runner's settings, and hands the session to `src/server/live_run.ts`,
which runs `claude -p` with stream-json both ways (`src/server/claude_stream.ts` over `src/server/line_program.ts`),
writes the stage input and the user's messages in, sends an interrupt or a switch of permission mode, holds each tool
call the session asks about (`can_use_tool`) in the transcript until the user answers it, folds the stream into the run's transcript
(`src/shared/runs/transcript.ts`) and plain output, saving both as it goes, and closes the input once a turn ends with
nothing more to say. On the last result the runner either waits for answers, moves the item to the stage its report
names, or fails the run saying why. A retry is a new run linked to the one it retries, its input carrying how that one
ended (`src/shared/runs/attempts.ts`). The page draws a run with `src/web/live/LiveRun.tsx` around
`src/web/transcript/TranscriptView.tsx`, which knows nothing of X-Dev's runs. `src/server/run_tools.ts`
is the run's tools as an HTTP server on 127.0.0.1 that the agent calls with curl, each run reaching only its item through a token. Proposals are items at the
`proposed` stage with the item and run they came from; a proposal whose title is close to an open item's is added to
that item instead.

## Gates

`src/shared/gates/model.ts` holds X-Dev's own checks as functions of what changed and passes on the X-Libs change checks
(`@x-tech-laboratories/x-libs/change_checks`) for the shared ones, so none needs a repository. `src/server/gates.ts`
reads the change with X-Libs `read_change` between a base and the worktree, uncommitted and untracked files included,
adds X-Dev's gates to an X-Libs check registry, runs the repository's own tests, type check and lint for the gates that
need them, and gives a result per gate. The runner runs a stage's gates once its
report arrives and stores the results and the user's overrides on the run; `src/cli/check.ts` is `x-dev-check`, X-Libs'
`run_check_command` with that registry.

## GitHub

`src/server/github.ts` is every call to `gh`. `src/server/github_sync.ts` keeps an item's issue in step: the runner
calls it once a run ends or is discarded, X-Libs' `CyclePoller` runs it over the open items, and **Sync to GitHub** runs
it for one. It works out what should be on GitHub with `src/shared/items/github.ts` and compares it with what it last
put there, kept on the item as JSON in the `github` column, so a look with nothing changed asks nothing of GitHub. The
pull request and its checks are the `pull_request` column. A run held only by its `ci` gate is checked again whenever
the checks change, and moves on once they pass.

## Items page and board

`src/web/items/index.tsx` holds the items page: one read of the items and one of the stages, the toolbar and filters,
the Inbox, and `use_pref("x-dev-items-layout")` for the view kept on the device; it hands the filtered items to the
list (an X-Libs `DataTable`, `groups` per repository when grouped) or to the board.
`src/web/board/index.tsx` draws the board from those items and stages and three reads of its own: `list_stage_runs` (the latest run of each
stage on each item, with a line from its report through `report_summary`, its cost, gates and questions), the
runner's `get_runner` for whether a run holds the slot, and its `list_run_changes` for the lines each finished run changed. It hands them to X-Libs' `Board`:
a column per stage, a lane per repository when grouped, and each item an `ItemCard` (`src/web/board/ItemCard.tsx`) in
the column of its stage, which takes the item, the stages and its runs and draws only the inside of the widget's card.
`can_move` allows only earlier columns (`is_send_back`), and `on_move` asks before calling `send_item_back`. The items
page is `contained`, so the Shell keeps the window still and the board scrolls inside the main pane.

## Runs page and diffs

`src/web/runs/` lists `list_run_summaries`, every run without its transcript, and sums tokens and cost by stage and
model with `sum_runs_by`. A run's tokens come from the result line's `usage`, added to the run after each turn. The
item page's Changes section asks the runner for `get_item_diff`, which `src/server/item_diff.ts` reads with git in the
item's worktree against the commit its first run started from, parses with `src/shared/diff/parse.ts` on parse-diff,
and `src/web/diff/DiffView.tsx` draws.

## Notifications

`src/daemon/run_notices.ts` checks after every run write, and every GitHub sync, how the runs under way and the open
items' pull requests changed since the last check (`run_notices` and `checks_notices` in
`src/shared/runs/notices.ts`), and shows the kinds `desktop.json` has on through X-Libs' `Notifier`, each keyed by its
item so a newer one replaces the older.

## History

`src/shared/history/store.ts` keeps a version of every item a write touches through X-Libs `create_history`, one
history per kind of item, each snapshot the item's rows across its tables. `bind_methods` records after every write, so
the page, the API and MCP are all covered; writes that arrive by sync are left to the device that made them.

## Sync

The server and every device run the same store. X-Libs `sync_engine` stamps every write to a synced table through
triggers, value by value; the newest write of each value wins. A device sends its changes within seconds and takes
everyone else's in the same round trip, follows the server's event stream to hear of changes at once, and keeps working
offline. On first connecting, the user chooses whether the server's copy or the device's wins; the other is backed up.

