# Changelog

All notable changes to cc-accounts are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.5.0 (2026-11-06)

- Projects can matter more than others. `/account priority 3` gives the project you are in a weight of 3, and `/account priority 0.5 <folder>` gives any folder one. The weights live in `~/.claude-shared/accounts/priorities.json`. When a session picks an account to move to, each session already there counts by its project's weight, so lighter projects keep off the accounts heavier ones use. On an account past 75% of its five-hour window or 90% of its week, a session of a lighter project moves off when a heavier one shares the account, leaving the rest to it. It moves only to an account with plenty of room.
- A bigger plan carries more sessions: an account's load is divided by its plan size, read from its login record (a Max 20x counts four Max 5x plans).
- `/account usage` shows what is free on every account and when it resets, the sessions on each account, the projects and their weights, and the totals in Max 5x plans: free now, and free before sessions start moving off. `/account` ends with the total free.
- cca refuses the account names `default`, `usage`, `priority` and `now`, which `/account` reads as its own words.

## 0.4.6 (2026-11-06)

- New `cca remove <name>`, for an account whose plan has ended. It takes the account out of the table, so no session starts or moves there, and drops its usage reading and failure records. Its folder and login stay, so `cca add <name> <folder>` brings it back. It refuses `~/.claude`, which every account links, and the account new sessions start on.
- A refusal that does not clear on its own keeps sessions off the account for a day, not an hour. That covers a lost login, an organization that turned off Claude Code on its subscription, a hold and a billing failure. Before, every session that needed to move tried such an account again each hour. A usage limit is still tried again after an hour.

## 0.4.5 (2026-11-06)

- A per-model limit now holds back only sessions on that model family. Before, an account that hit its Fable cap was skipped for an hour by every session, including those on Opus or Sonnet, for which it still had room. The failure is recorded under the family of the session's model, `blocked/<account>/<family>.json`. A lost login, a hold or a billing failure, or a limit whose family cannot be told, still holds back every session (`blocked/<account>/account.json`).
- A usage limit the readings show (a 5-hour or weekly window at its limit) leaves no failure record. The readings already show it to every session, with its reset time, and an hour-long record could outlast a reset minutes away.
- cca removes day-old failure records along with day-old background records.

## 0.4.4 (2026-11-06)

- A session stopped by a limit the usage readings do not show now moves. That covers a per-model weekly cap (on 2026-10-26 one conversation hit its Fable limit 23 times in a row and stayed) and a login the account lost. The balancer reads the error class Claude Code writes to the transcript (`rate_limit`, `authentication_failed`, `billing_error` and the like). That class means the same as the StopFailure hook's word, but StopFailure only runs after the turn has completed.
- A session the limit stopped takes any account below the leave line, 90% of five hours or 95% of the week. Before, it waited for one below 70% and 90% and stayed stopped when none was.
- An account that failed a call for a reason of its own is skipped by every session for an hour, so sessions cannot bounce between accounts that both hit a per-model limit.
- A planned move is skipped when the full window resets within 15 minutes. A move makes the new account read the whole conversation uncached, and a limit hit in those minutes still moves at once.

## 0.4.3 (2026-11-06)

- A message sent as a switch begins is no longer lost. If the old process never took it, cca-stream sends it to the new one. If the switch cut short the turn it started, the reopened conversation is told to carry on.
- Scheduled wakeups are handed over with their prompts whole, including one set in the turn the usage limit stopped. They are read from CronList when the switch happens. The Stop hook's list clips prompts at 1000 characters and is not sent for a turn the limit stops.
- A VS Code switch now keeps every option the panel passed except those that pick the conversation, and that list is the one a terminal relaunch uses. Before, `--resume-session-at`, `--resume-drops-turn` and `--from-pr` survived a switch and could reopen the conversation at an old message.
- A move the usage limit forces ends the process once. Two timers could both carry it out and signal the process twice.
- A switch that cannot end its process is withdrawn, so the panel no longer hangs with its input held.
- Usage readings, conversation records and the default account are written to a temporary file and renamed into place, so a reader never takes a half-written reading for an empty account.
- `/account` in a VS Code tab opened before 0.4.0 names the wakeups the switch will end. The 0.4.1 entry said those wakeups were handed over; for such a tab they never were.
- Only a stream-json session runs under cca-stream. `cca <claude binary> ...` typed in a terminal runs Claude Code itself again.
- The shell tests unset `CCA_SHARED`, which a session started by cca 0.4.0 or later passes to the tests it runs.

## 0.4.2 (2026-11-06)

- The balancer prefers an account whose usage a session has reported over one nobody has measured. An unmeasured account was scored as empty, so a move could land on one that was itself nearly spent and bounce again; it is now a last resort.

## 0.4.1 (2026-11-06)

- A switch no longer loses the session's scheduled wakeups (`/loop`, ScheduleWakeup, CronCreate) without a word. The Stop hook now records them, and the reopened conversation gets a message listing each one to schedule again. This covers `/account` as well as the moves 0.4.0 added. A VS Code session started before 0.4.0 cannot get that message, so it keeps its wakeups and moves only when the limit stops a turn.

## 0.4.0 (2026-11-05)

- Sessions move off an account before its usage limit stops them. Every session saves its account's five-hour and weekly usage to `~/.claude-shared/accounts/usage/<account>.json`, so each one knows the accounts it is not on. At the end of a turn, a session whose account is at 90% of its five-hour window or 95% of its week moves to the signed-in account with the most room, counting the live sessions already on each so that sessions leaving together spread out. It waits for its background work as `/account` does. A turn the limit itself stopped moves at once and reopens with a message telling the conversation to carry on, naming any background work the move stopped, so the work continues with nobody typing. `CCA_BALANCE=off` turns the moves off.
- In VS Code a switch no longer waits for your next message. The wrapper keeps the panel's process alive (`libexec/cca-stream`), starts Claude Code under it, and when a switch ends Claude Code, starts it again on the new account in the same tab, replaying the panel's session setup.
- In a terminal, a switch that carries a follow-up reopens the conversation with it as the first prompt.
- The status line and `/account` show each account's last usage reading.
- `/account` no longer cuts work short. Ending the process for a switch stopped the turn in flight and every subagent, Monitor and background command, which then had to be resumed by hand. A switch now waits until the turn has ended and the background work has finished, replying at once with what it waits for, and happens on its own when the last task's notification turn ends. `/account <name> now` switches at once; `/account <current account>` cancels a queued switch. The plugin learns the session's background work from a Stop command hook, `record-tasks.py`, because hooks modules do not get the Stop event where the built-in security plugin is seated.
- `cca help` prints the whole comment block however long it is.

## 0.3.1 (2026-10-24)

- In VS Code, `/account` on a session in the middle of a turn ended the turn instead of the process, so the conversation ran twice: the old process beside the one the panel started on the new account. The switch now waits for the process to exit, sends SIGINT again to the now idle session, and SIGTERM last; a process that survives is reported in the session log.

## 0.3.0 (2026-10-23)

- User MCP servers live in one file, `~/.claude-shared/mcp.json`, which every session cca starts loads with `--mcp-config`. Server names, and so tool names, stay the same. At each start cca moves the user servers an account holds into the file, so no account keeps a copy; one added later with `claude mcp add --scope user` on any account is moved in the same way. Edit the file to change or remove a server. Before, 0.2.0 kept a copy in every account.
- `CCA_MCP_SYNC=off` stops the moving and the per-project sync; the file is still loaded.

## 0.2.0 (2026-10-23)

- MCP servers are the same on every account: user servers, a project's local servers, and your answers about a project's `.mcp.json` servers. A server added, changed or removed on one account changes on the others when they next start. Before, each account kept its own, so a session's tools depended on its account. `CCA_MCP_SYNC=off` turns this off.
- Folder trust and MCP servers sync before VS Code sessions start too, not only in a terminal. Without trust, VS Code sessions skipped an MCP server's `headersHelper` and the MCP servers and hooks an agent definition brings.
- Auto memory writes no longer ask for permission. Every account reached its memory through the link to the shared conversations, and Claude Code compares a memory write's real path with the memory folder's configured path, so the two never matched. cca now names the folder by its real path.
- `cca add` refuses a folder another account already uses.
- A preference saved from VS Code with an empty account table runs once instead of failing.
- The plugin's version matches the release again.

## 0.1.2 (2026-10-22)

- VS Code: the Claude in Chrome and memory dialogs save their setting to every account. Before, the extension's helper run went to the default account, so a panel on any other account kept reporting Claude in Chrome off and never connected it.

## 0.1.1 (2026-10-20)

- VS Code in WSL or over SSH: setup now sets the process wrapper in the editor server's machine settings, where a remote window reads it. Before, `/account` did not reach those windows.
- Setup also covers an editor that is installed but has no settings file yet.
- fish: setup writes fish syntax to `config.fish`. Other unknown shells get the lines to add.
- Running `cca init` again while Claude Code is open works; it only asks you to quit when it has folders to move.
- `install.sh` explains how to use WSL when run on Windows outside it, says "Updated" when run again, and installs a tag without git's detached-HEAD notes.
- The README is shorter, with step-by-step setup and Windows instructions.

## 0.1.0 (2026-10-20)

First release.

- `cca` runs Claude Code on several accounts, each its own config directory, with conversations, the session list and settings shared between them.
- `cca init`, `cca add`, `cca use`, `cca uninstall` and `install.sh` set it up and take it down.
- `claude --resume <id>` opens a conversation on the account it last ran on.
- The `/account` plugin moves a conversation to another account: in a terminal it reopens in place with the same options; in VS Code (and Cursor, Windsurf, VS Code Insiders, VSCodium) the next message continues on the new account.
- Folder trust is synced between accounts.
