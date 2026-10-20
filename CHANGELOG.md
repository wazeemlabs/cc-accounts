# Changelog

All notable changes to cc-accounts are listed here. Versions follow [Semantic Versioning](https://semver.org).

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
