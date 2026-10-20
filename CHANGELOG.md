# Changelog

All notable changes to cc-accounts are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 (2026-10-20)

First release.

- `cca` runs Claude Code on several accounts, each its own config directory, with conversations, the session list and settings shared between them.
- `cca init`, `cca add`, `cca use`, `cca uninstall` and `install.sh` set it up and take it down.
- `claude --resume <id>` opens a conversation on the account it last ran on.
- The `/account` plugin moves a conversation to another account: in a terminal it reopens in place with the same options; in VS Code (and Cursor, Windsurf, VS Code Insiders, VSCodium) the next message continues on the new account.
- Folder trust is synced between accounts.
