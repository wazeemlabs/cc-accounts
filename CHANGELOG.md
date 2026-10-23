# Changelog

All notable changes to cc-accounts are listed here. Versions follow [Semantic Versioning](https://semver.org).

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
