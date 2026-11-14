# cc-accounts

[![CI](https://github.com/wazeemlabs/cc-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/wazeemlabs/cc-accounts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use several Claude Code accounts on one computer, move a conversation from one account to another without losing it, and keep every session off accounts that are about to hit their usage limit.

```
> /account personal
  Switching to personal: this session closes and reopens on it.
```

Works in the terminal and in VS Code (also Cursor and Windsurf), on macOS, Linux and Windows (through WSL).

## Setup

You need [Claude Code](https://code.claude.com/docs/en/overview), git and python3. On Windows, follow [the Windows steps](#windows) instead.

**1. Quit Claude Code**, in every terminal and editor.

**2. Install.** Replace `work` with any short name for the account you are signed in to now:

```sh
curl -fsSL https://raw.githubusercontent.com/wazeemlabs/cc-accounts/main/install.sh | bash -s -- work
```

**3. Open a new terminal and add your other accounts**, one name each. Claude Code opens for each one: sign in with `/login`, then quit it.

```sh
cca add personal
```

**4. In VS Code**, reload the window once (Command Palette, then "Developer: Reload Window").

Done. Keep using `claude` as before.

## Everyday use

| To | Do |
|---|---|
| Move the conversation you are in to another account | Type `/account personal` in Claude Code |
| See your accounts | Type `/account`, or run `cca` in a terminal |
| Start Claude Code on a given account | `cca personal` |
| Choose the account new sessions start on when no week resets sooner | `cca use personal` |

In a terminal, `/account` closes the session and reopens the same conversation on the other account, with the options you started it with. In VS Code, the conversation reopens on the other account in the same tab.

A switch does not cut work short. If Claude is in the middle of a turn, or a subagent, a Monitor or a background command is still running, `/account` replies at once that the switch is queued and names what it is waiting for. The switch happens when the turn has ended and that work has finished; a finished task wakes the session, so the switch follows on its own. Until then the session stays on its account, and messages you send run there.

- `/account personal now` switches at once and stops whatever is running.
- `/account <this session's account>` cancels a queued switch.
- Scheduled wakeups (`/loop`, ScheduleWakeup, CronCreate) are not waited for. Claude Code restores them when the conversation reopens on the other account.

`claude --resume` opens a conversation on the account it last ran on.

## Staying under the usage limits

You do not need to do anything for this. Every session saves its account's five-hour and weekly usage where the other sessions can read it. When a turn ends with the session's account at 90% of its five-hour window or 99% of its week, the session moves to another signed-in account with room. It takes the account whose week resets first, since room left in a week is lost when the week resets, as long as that account's five-hour window can carry the sessions working on it: each counts 10 points against the window, and an account whose use plus that count reaches the bar is passed over while another has room. Among accounts whose weeks reset together it takes the one with the most five-hour room after that count, so sessions that leave one account together spread out. A session idle for half an hour counts for nothing until it works again. The move waits for the session's background work, as `/account` does.

A session also moves with nothing pressing on its account, when another account's week resets at least six hours before its own and has room below the take line (70% of five hours, 97% of the week). So a week about to reset is spent before its room is lost, and the later weeks keep theirs. An account nobody has measured yet, whose reset is unknown, never draws a session this way. And a session moves when the sessions working on its account would fill its five-hour window, use plus 10 points each reaching 90%, to an account with room by the same count. A session checks only when a turn ends, and without this many sessions sent to one account fill its five-hour window during a long turn, which then stops on the limit.

If the limit stops a turn before that happens, the session moves at once and the conversation reopens with a message telling it to carry on, so the work goes on with nobody typing. That message names any background work the move stopped. A move already waiting for background work, the balancer's or one you asked for with `/account`, also goes at once when the account stops a turn, to the account it was waiting to move to.

New sessions start on the account a move would pick: the one with room whose week resets first. The default account wins among accounts whose weeks reset together, and when no account's reset is known yet. `/account` and `cca` show where new sessions start now.

- The status line shows the account and its usage, for example `account work · 5h 42%, week 10%`, and `/account` lists every account's last reading with the total free.
- `/account usage` shows, for every account, how much of its five-hour window and its week is free and when each resets. It also shows the sessions on each account and the projects they belong to. At the bottom are the totals over the accounts that can serve a session, in Max 5x plans (a Max 20x counts four). The figures that matter: what is free now, and what is free before sessions start moving off.
- An account no session has used yet counts as unused until one reports.
- When no other account has room, the session stays and says so in its log.
- `CCA_BALANCE=off` turns the moves off. Readings are still saved.

### Projects that matter more

Some projects matter more than others. Give one a weight, and its sessions get more of the room:

```
/account priority 3              this project (the folder the session works in) counts as 3
/account priority 0.5 ~/scratch  a folder you care less about counts as half
/account priority                show the weights set
```

A project without a weight counts as 1, and a folder inside a weighted one takes its weight. Two rules use the weights:

- When a session picks an account to move to, each session already on an account counts by its weight. Sessions of lighter projects therefore keep off the accounts where heavier ones run, and those accounts' hours go to the heavier project.
- When an account passes 75% of its five-hour window or 90% of its week, a session of a lighter project moves off if a heavier one shares the account. The rest of the account then goes to the heavier project. It only moves to an account with plenty of room; if there is none, it stays.

The weights are kept in `~/.claude-shared/accounts/priorities.json`, which every session and account reads.

### Budgets, so every project lasts the week

Weights decide who gets an account's room; budgets decide how much each project may spend in a day, so that one project cannot use up the week before another has had its share. A budget is in points, one percent of a Max 5x week, per UTC day:

```
/account budget 35 ~/Documents/Studio   the studio's sessions may spend 35 points a day
/account budget 4                        this project may spend 4 a day
/account budget                          show every project's budget, spend and standing today
/account budget 0 ~/Documents/Studio    remove it
```

Each day the accounts supply so many points: each account's room below the leave line, spread evenly until its week resets, plus a fresh week's share once it has. A project with a budget gets its budget. The projects without one share what is left, by their weights. A project may spend its allowance a quarter of a day ahead of the clock, so a burst at the start of the day is not parked at once.

Every session counts what its turns cost (input, cached and output tokens, weighted by model: Opus 1, Fable 2, Sonnet 0.6, Haiku 0.2, and cache reads at a tenth), and the accounts' own readings say what those tokens come to in points, so spend is counted in the same unit as the budgets. A project that has spent more than its allowance so far is over budget: its sessions are parked between turns. A parked session's tool calls are refused with a line saying how much was spent, how much was allowed and when the day turns, and it goes on by itself once the allowance catches up or the day turns. A turn in flight is never cut. Sessions the Claude desktop app opens without a folder each start in a scratch folder of their own under `~/Library/Application Support/Claude/scratch-workspaces`. While any budget is set, they count as one project, that folder, with a default budget of 5 points a day, so they keep working when the budgets set take everything the accounts supply. `/account budget <points> "~/Library/Application Support/Claude/scratch-workspaces"` changes it; 0 brings the default back. With no budget set, nothing is parked. `CCA_BUDGET=off` turns parking off; spend is still counted.

A client that calls Claude outside a Claude Code session, such as an LLM bridge signed in to one of the accounts, counts its calls with `cca spend` after each one:

```
cca spend <model> <input> <output> <cache_read> <cache_write> --project <folder> --account <name or email>
```

The call's tokens then count in the project's budget and in the readings' calibration, like a session's turns. Without this, a bridge's use raises an account's reading with nothing counted beside it, and every project's tokens read as more points than they are. An account only a client uses gives no readings, since only Claude Code sessions report them; its calls still count in their project's budget, and stay out of calibration that day. `cca spend` exits 2 when it refuses the call (an account no name or email matches, a count that is not a whole number, a project that is not an absolute folder); a model it does not know is kept and weighed as Opus, as a session's turns are.

`/account usage` ends with the budgets table. The files: `budgets.json`, `spend/<day>/<session>.json` (`client-<account>-<digest>.json` for `cca spend`) and `calibration/<day>/<account>.json` under `~/.claude-shared/accounts`.

## What it does

Claude Code keeps one login per config folder, and each folder keeps its own conversations. cc-accounts gives each account its own folder and shares these between all of them:

- your conversations, so any account can continue any of them;
- the list of running sessions;
- `settings.json`, `CLAUDE.md`, `agents`, `commands` and `keybindings.json` (change the list in `~/.claude-shared/accounts/share.conf`);
- folder trust, so a folder you trusted on one account does not ask again on another (set `CCA_TRUST_SYNC=off` to stop this).
- your MCP servers. The user ones live in one file, `~/.claude-shared/mcp.json`, which every session cca starts loads; edit it to add, change or remove a server. One you add with `claude mcp add --scope user` on any account is moved into it at the next start. A project's local servers and your answers about its `.mcp.json` servers are synced: a change on one account reaches the others when they next start. `CCA_MCP_SYNC=off` stops cca moving and syncing them; the file is still loaded.
- the preferences VS Code's Claude in Chrome and memory dialogs save, which Claude Code keeps per account: a change in either dialog is applied to every account.

Plugins follow the shared `settings.json`: each account installs the plugins it enables when it starts. Each account keeps its own login and its claude.ai connectors.

How it works, and every file it writes: [docs/how-it-works.md](docs/how-it-works.md).

## Windows

Use cc-accounts inside WSL (Windows Subsystem for Linux), with Claude Code installed in WSL too.

1. If you do not have WSL, run `wsl --install` in PowerShell and restart.
2. Open your WSL terminal (for example Ubuntu) and install Claude Code there: `curl -fsSL https://claude.ai/install.sh | bash`.
3. If you use VS Code: install its "WSL" extension and open a folder in WSL once ("WSL: Connect to WSL"), then close VS Code.
4. Follow [Setup](#setup) in the WSL terminal.

Claude Code installed directly on Windows (from PowerShell or CMD) is not supported yet: folder links, process signals and the editor wrapper work differently there. Native support is tracked in [issue #1](https://github.com/wazeemlabs/cc-accounts/issues/1).

## Update and uninstall

To update, run the install command again without a name:

```sh
curl -fsSL https://raw.githubusercontent.com/wazeemlabs/cc-accounts/main/install.sh | bash
```

To uninstall:

```sh
cca uninstall
rm -rf ~/.local/share/cc-accounts
```

Your accounts and conversations stay where they are.

## Good to know

- Installed a new editor, or connected VS Code to WSL or a remote machine, after setup? Run `cca init` again with your first account's name (`cca init work`). It only adds what is missing.
- `/account` uses Claude Code's plugin API, which is in early access (tested with Claude Code 2.1.305). If your Claude Code does not load the plugin, everything else still works, and `cca personal --resume <conversation id>` moves a conversation by hand.
- When switching in a terminal, options such as `--model` and `--add-dir` carry over. The first prompt and one-time options such as `--print` and `--worktree` do not; cca says what it left out.
- If your editor's settings file has comments, setup does not rewrite it and prints the line to add instead.
- In an editor, a conversation with no saved permission mode starts in Manual mode, and the session list also shows sessions started by scripts. The Claude Code extension does this whenever a process wrapper is set.
- Sessions on claude.ai (cloud sessions) belong to one account and are not shared.
- Claude Code run directly, not through `claude` or `cca` (for example `~/.local/bin/claude` in a script), does not load `~/.claude-shared/mcp.json`. Add `--mcp-config ~/.claude-shared/mcp.json` to such a run.
- Prompt history (the up arrow) and plan files stay on the account that wrote them. After a switch, the plan is still in the conversation.
- The editor's plugin manager and its claude.ai design sign-in run on the account new sessions start on, because nothing tells cca which panel asked.
- cc-accounts relies on parts of Claude Code that are not documented, and a Claude Code update can change them. CI checks it against the latest Claude Code every week.

## All commands

| Command | What it does |
|---|---|
| `cca` | List the accounts. `*` marks where new sessions start: the default, or another account while the default is low on room or another account's week with room resets sooner. |
| `cca <name> [claude options]` | Run Claude Code on `<name>`. |
| `cca add <name> [folder]` | Add an account. Its folder defaults to `~/.claude-<name>`. Running it again for an account relinks what it shares. |
| `cca use <name>` | Start new sessions on `<name>` while it has room and no other account's week with room resets sooner. |
| `cca remove <name>` | Stop using `<name>`, for a plan that ended: no session starts or moves there. Its folder and login stay, so `cca add <name> <folder>` brings it back. |
| `cca init <name>` | Set up, naming the account you are signed in to now. The installer runs this. |
| `cca uninstall` | Undo setup's changes to your shell, settings and editors. |
| `cca version`, `cca help` | |
| `/account` | In Claude Code: list the accounts with their last usage readings. |
| `/account <name>` | In Claude Code: move this conversation to `<name>` once its turn and background work have finished. |
| `/account <name> now` | In Claude Code: move it at once, stopping that work. |
| `/account default <name>` | In Claude Code: start new sessions on `<name>` while it has room and no other account's week with room resets sooner. |
| `/account usage` | In Claude Code: what is free on every account, when it resets, and where each project's sessions run. |
| `/account priority [<weight> [<folder>]]` | In Claude Code: show the project weights, or set this project's (or a folder's). |
| `/account budget [<points a day> [<folder>]]` | In Claude Code: show every project's budget and spend today, or set this project's (or a folder's); 0 removes it. |

Environment variables: `CCA_BALANCE=off` stops sessions moving off accounts that are nearly spent, `CCA_BUDGET=off` stops sessions being parked over budget, `CCA_TRUST_SYNC=off` stops folder trust syncing, and `CCA_MCP_SYNC=off` stops cca moving user MCP servers into the shared file and syncing per-project ones. `CCA_ROOT` and `CCA_SHARED` move cc-accounts' own folders (by default `~/.claude-shared/accounts` and `~/.claude-shared`). For the installer, `CCA_REF=v0.1.1` installs a given release and `CCA_HOME` changes where it installs.

## Use only your own accounts

Use cc-accounts only with accounts you are allowed to use, and follow the terms of each one.

cc-accounts is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Contributing

Bug reports and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
