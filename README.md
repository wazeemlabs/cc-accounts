# cc-accounts

[![CI](https://github.com/wazeemlabs/cc-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/wazeemlabs/cc-accounts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run Claude Code on several accounts and move a conversation from one account to another, in the terminal and in VS Code.

```
$ cca
* work       you@company.com                  /Users/you/.claude
  personal   you@example.com                  /Users/you/.claude-personal
  client     you@client.org                   /Users/you/.claude-client
* new sessions start here. Move a running one with /account <name>.
```

Inside a session:

```
> /account personal
  Switching to personal: this session closes and reopens on it.
```

The conversation reopens on the other account with its history, in the same terminal, with the flags you started it with.

## Why

Claude Code keeps one login per config directory, and each directory keeps its own conversations. If you have more than one account (work and personal, or a client's organization), switching accounts means losing your place: the conversation you were in belongs to the other directory.

cc-accounts gives each account its own config directory, as Claude Code expects, and shares the conversations, the session list and your settings between them. Any account can pick up any conversation.

## What you get

- `cca <name>` runs Claude Code on that account.
- `/account <name>` moves the conversation you are in to another account. In a terminal it closes and reopens on the new account with the same flags. In VS Code, the next message you send continues on the new account.
- `claude --resume <id>` opens a conversation on the account it last ran on.
- Conversations, the session list (so sessions on different accounts can message each other), `settings.json` and `CLAUDE.md` are shared.
- Folder trust is synced: a folder you trusted on one account opens without the trust prompt on the others. Set `CCA_TRUST_SYNC=off` to turn this off.
- The status line shows which account a session runs on.

## Requirements

- macOS or Linux (WSL works as Linux).
- [Claude Code](https://code.claude.com/docs/en/overview), installed with the native installer.
- bash, git and python3 3.8 or newer.

`/account` is a Claude Code plugin built on Claude Code's plugin API, which is in early access; cc-accounts is tested with Claude Code 2.1.304. Where the plugin does not load, everything else works, and `cca <name> --resume <id>` moves a conversation by hand.

## Install

Quit Claude Code first: setup moves `~/.claude`'s conversations into a shared folder. Then install, naming the account you are signed in to now:

```sh
curl -fsSL https://raw.githubusercontent.com/wazeemlabs/cc-accounts/main/install.sh | bash -s -- work
```

This clones cc-accounts into `~/.local/share/cc-accounts` and runs `cca init work`. Open a new terminal, then add your other accounts. Each one opens Claude Code so you can sign in with `/login`:

```sh
cca add personal
cca add client
```

To install from a clone instead: `git clone https://github.com/wazeemlabs/cc-accounts && cc-accounts/install.sh work`. To pin a release, set `CCA_REF=v0.1.0`.

## Usage

| Command | What it does |
|---|---|
| `cca` | List the accounts. `*` marks where new sessions start. |
| `cca <name> [claude args]` | Run Claude Code on `<name>`. |
| `claude [args]` | After setup, runs through cca: a resumed conversation opens on the account it last ran on, anything else on the default. |
| `cca use <name>` | Start new sessions on `<name>`. |
| `cca add <name> [dir]` | Add an account. Its directory defaults to `~/.claude-<name>`. Run it again for an existing account to relink what it shares. |
| `cca init <name>` | Set up, naming the account in `~/.claude`. `install.sh` runs this. |
| `cca uninstall` | Undo setup's changes to your shell, settings and editor. |
| `/account` | Inside a session: list the accounts. |
| `/account <name>` | Inside a session: move this conversation to `<name>`. |
| `/account default <name>` | Inside a session: start new sessions on `<name>`. |

### Moving a conversation

In a terminal started with `claude` or `cca`, `/account <name>` closes the session and cca reopens the same conversation on `<name>`. Options such as `--model`, `--effort` and `--add-dir` carry over. The prompt you started with and one-time options (`--print`, `--worktree`, `--continue`) do not, and cca prints what it left out.

In VS Code, `/account <name>` records the choice and ends the Claude Code process. The next message you send starts a new one on `<name>`, in the same tab, with the conversation intact.

### VS Code and other editors

Setup sets `claudeCode.claudeProcessWrapper` in VS Code's user settings (and in Cursor, Windsurf, VS Code Insiders and VSCodium where they are installed), so the Claude Code extension starts Claude through cca. Reload the window after setup. If your settings file has comments, cca does not rewrite it; it prints the line to add.

With a process wrapper set, the extension changes two small things on its own: a conversation with no saved permission mode starts in Manual mode, and the session list also shows sessions started by scripts.

## What is shared

| | Where it lives |
|---|---|
| Conversations, todos, file history, the session list | `~/.claude-shared`, linked into every account |
| `settings.json`, `CLAUDE.md`, `agents`, `commands`, `keybindings.json` | `~/.claude`, linked into every other account. Edit the list in `~/.claude-shared/accounts/share.conf`. |
| Folder trust | Each account's `.claude.json`, synced when an account starts |
| Login | Each account's own credential (the macOS keychain, or the account's directory on Linux). cca never reads it. |
| Installed plugins, user-scope MCP servers, skills synced from claude.ai | Each account's own. Add them on each account, or use a project's `.mcp.json`. |

## How it works

Each account is a Claude Code config directory, chosen with the `CLAUDE_CONFIG_DIR` environment variable. cca picks the directory when it starts Claude Code, records which account each conversation ran on, and restarts Claude Code on another account when `/account` asks it to. The details, including what cca writes and why, are in [docs/how-it-works.md](docs/how-it-works.md).

cc-accounts relies on parts of Claude Code that are not documented: `CLAUDE_CONFIG_DIR`, the layout of `~/.claude`, the VS Code extension's process wrapper, and the format of `claude --help`. A Claude Code update can change them. The test suite checks the formats cca reads against the installed Claude Code, and CI runs it against the latest release.

## Uninstall

```sh
cca uninstall
rm -rf ~/.local/share/cc-accounts
```

Your accounts and conversations stay where they are. To stop sharing conversations, replace the links in `~/.claude` (`projects`, `todos`, `file-history`, `sessions`) with the folders in `~/.claude-shared`.

## Using several accounts

Use cc-accounts only with accounts you are allowed to use, and follow the terms that apply to each of them.

cc-accounts is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
