# Security

## Reporting a problem

Report a security problem privately through [GitHub's security advisories](https://github.com/wazeemlabs/cc-accounts/security/advisories/new), not in a public issue.

## What cc-accounts touches

- It never reads, copies or writes an account's login, which stays where Claude Code keeps it. The one credential it handles is a long-lived token you give it with `cca token <name>`: it is kept in the macOS Keychain (service `cc-accounts`), or elsewhere in a file only you can read (`~/.claude-shared/accounts/tokens/<name>`), reaches the Keychain on standard input and never as a command argument, is never printed or logged, and is passed to Claude Code in `CLAUDE_CODE_OAUTH_TOKEN` when that account runs.
- It writes the files listed in [docs/how-it-works.md](docs/how-it-works.md#files-cca-writes), all in your home directory.
- It reads each account's `.claude.json` for the account's email address and its trusted folders.
- It makes no network requests. `install.sh` clones this repository with git.

Folder trust decides whether Claude Code runs a project's hooks and settings without asking. cc-accounts copies trust between your own accounts only, so a folder is trusted on every account once you trust it on one. To turn this off, set `CCA_TRUST_SYNC=off` in your shell's environment.
