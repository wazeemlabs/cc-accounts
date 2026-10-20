# cc-accounts

[![CI](https://github.com/wazeemlabs/cc-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/wazeemlabs/cc-accounts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use several Claude Code accounts on one computer, and move a conversation from one account to another without losing it.

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
| Choose the account new sessions start on | `cca use personal` |

In a terminal, `/account` closes the session and reopens the same conversation on the other account, with the options you started it with. In VS Code, the switch happens at the next message you send, in the same tab.

`claude --resume` opens a conversation on the account it last ran on.

## What it does

Claude Code keeps one login per config folder, and each folder keeps its own conversations. cc-accounts gives each account its own folder and shares these between all of them:

- your conversations, so any account can continue any of them;
- the list of running sessions;
- `settings.json`, `CLAUDE.md`, `agents`, `commands` and `keybindings.json` (change the list in `~/.claude-shared/accounts/share.conf`);
- folder trust, so a folder you trusted on one account does not ask again on another (set `CCA_TRUST_SYNC=off` to stop this).

Each account keeps its own login, installed plugins and user-level MCP servers. Add plugins and MCP servers on each account, or put MCP servers in a project's `.mcp.json`.

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
- `/account` uses Claude Code's plugin API, which is in early access (tested with Claude Code 2.1.304). If your Claude Code does not load the plugin, everything else still works, and `cca personal --resume <conversation id>` moves a conversation by hand.
- When switching in a terminal, options such as `--model` and `--add-dir` carry over. The first prompt and one-time options such as `--print` and `--worktree` do not; cca says what it left out.
- If your editor's settings file has comments, setup does not rewrite it and prints the line to add instead.
- In an editor, a conversation with no saved permission mode starts in Manual mode, and the session list also shows sessions started by scripts. The Claude Code extension does this whenever a process wrapper is set.
- Sessions on claude.ai (cloud sessions) belong to one account and are not shared.
- cc-accounts relies on parts of Claude Code that are not documented, and a Claude Code update can change them. CI checks it against the latest Claude Code every week.

## All commands

| Command | What it does |
|---|---|
| `cca` | List the accounts. `*` marks where new sessions start. |
| `cca <name> [claude options]` | Run Claude Code on `<name>`. |
| `cca add <name> [folder]` | Add an account. Its folder defaults to `~/.claude-<name>`. Running it again for an account relinks what it shares. |
| `cca use <name>` | Start new sessions on `<name>`. |
| `cca init <name>` | Set up, naming the account you are signed in to now. The installer runs this. |
| `cca uninstall` | Undo setup's changes to your shell, settings and editors. |
| `cca version`, `cca help` | |
| `/account` | In Claude Code: list the accounts. |
| `/account <name>` | In Claude Code: move this conversation to `<name>`. |
| `/account default <name>` | In Claude Code: start new sessions on `<name>`. |

Environment variables: `CCA_TRUST_SYNC=off` stops folder trust syncing. `CCA_ROOT` and `CCA_SHARED` move cc-accounts' own folders (by default `~/.claude-shared/accounts` and `~/.claude-shared`). For the installer, `CCA_REF=v0.1.1` installs a given release and `CCA_HOME` changes where it installs.

## Use only your own accounts

Use cc-accounts only with accounts you are allowed to use, and follow the terms of each one.

cc-accounts is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Contributing

Bug reports and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
