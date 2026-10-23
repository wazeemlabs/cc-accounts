# How cc-accounts works

This is what cca does, what it writes, and which parts of Claude Code it depends on. Read it before changing cca, or when an update to Claude Code breaks something.

## Accounts are config directories

Claude Code reads its login, its global config and its conversations from one directory: `~/.claude` by default, or the directory named by the `CLAUDE_CONFIG_DIR` environment variable. Each account in cc-accounts is one such directory. `~/.claude-shared/accounts/accounts.tsv` lists them, one `name<TAB>directory` per line.

The account in `~/.claude` is special. Claude Code runs it with `CLAUDE_CONFIG_DIR` unset, and cca does the same. Setting the variable, even to `~/.claude` itself, makes Claude Code look for a credential of its own (on macOS a keychain entry named after a hash of the path), so the account would read as signed out. Its global config is `~/.claude.json`; every other account's is `<directory>/.claude.json`.

## What is shared, and how

`cca init` moves four folders out of `~/.claude` into `~/.claude-shared` and links them back: `projects` (the conversations), `todos`, `file-history` and `sessions` (the list of running sessions, which lets sessions on different accounts find and message each other). `cca add` links the same four into each new account's directory.

`cca add` also links the items named in `~/.claude-shared/accounts/share.conf` from `~/.claude` into the new account, so all accounts use one `settings.json` and one `CLAUDE.md`. Anything already at a link's place is kept beside it as `<name>.bak-<time>`. Claude Code writes `settings.json` through the link (checked: a settings write keeps the link). Plugins follow from it: `enabledPlugins` is in `settings.json`, and Claude Code installs every plugin it enables when it starts, on each account.

Not everything can be a link. Claude Code refuses to prune `history.jsonl` when it is not a regular file, so prompt history stays per account. `plansDirectory` must be inside the project, so plan files stay per account too; a resumed conversation still holds its plan.

## Auto memory and the shared folder

Auto memory lives in the conversations folder (`<config>/projects/<project>/memory/`), which every account reaches through its `projects` link. Claude Code lets a memory write through without asking only when the file's real path starts with the memory folder's path as configured. Through the link the two never match (`~/.claude-shared/projects/...` against `~/.claude/projects/...`), and the folder is inside the protected `~/.claude`, so every memory write asked for permission, or was refused in a headless run.

cca sets `CLAUDE_CODE_REMOTE_MEMORY_DIR` to `~/.claude-shared` for every session. Claude Code then names the memory folder by its real path, `~/.claude-shared/projects/<project>/memory/`, the same folder as before, and memory writes go through. The variable also moves agent memory: a `user` agent's to `~/.claude-shared/agent-memory/`, shared by every account, and a `local` one's from `<project>/.claude/agent-memory-local/` to `~/.claude-shared/projects/<project>/agent-memory-local/`.

## Choosing the account for a run

`cca run` (what `claude` runs after setup) picks an account in this order:

1. With `--resume <id>`, the account that conversation last ran on. The plugin records it in `~/.claude-shared/accounts/by-session/<id>` each time a session starts. Records untouched for 180 days are deleted at the next launch, and those conversations open on the default.
2. `CLAUDE_ACCOUNT`, when set. cca sets it for every session it starts, so a `claude` run inside a session (by a tool or a script) stays on that session's account.
3. The default, from `~/.claude-shared/accounts/default` (`cca use`).

`cca <name>` skips the choice and runs on `<name>`.

## Moving a conversation in a terminal

cca does not replace itself with Claude Code. It starts Claude Code as a child and waits, with three variables set: `CLAUDE_ACCOUNT_SWITCH_FILE` (a file under `~/.claude-shared/accounts/switch/`), `CCA_MODE=terminal`, and `CCA_PID`, cca's own pid.

`/account <name>` checks that `CCA_PID` is the pid of its process's parent, so a `claude` started inside the session (which inherits the variables) cannot act for it. It then writes `<name> <conversation id>` to the switch file and runs `/exit`. A command cannot run another command from inside itself, so the plugin runs `/exit` from a zero-delay timer, which Claude Code queues until the `/account` command has finished.

When Claude Code exits, cca reads the switch file. If it holds a request, cca starts Claude Code again on the named account with `--resume <id>` and the options of the first run. `libexec/cca-keep-args` decides which options to keep: it reads each option's arity from `claude --help` (a flag, one value, an optional value, or several values), drops the prompt and the options that pick a conversation or start something a second run must not repeat, and prints what it dropped. An option `claude --help` does not list is dropped too, because its value cannot be told apart from a prompt.

## Moving a conversation in VS Code

The Claude Code extension starts Claude Code itself, so cca cannot wait on it. Setup sets `claudeCode.claudeProcessWrapper` to cca. The setting is machine-scoped: a desktop window reads it from the editor's user settings, and a remote window (WSL, SSH) from the editor server's machine settings on the remote machine. Setup writes it in both places for every VS Code family editor set up on the machine it runs on. The extension then runs `cca <its own claude binary> <args>`. cca picks the account as above and replaces itself with Claude Code (`exec`), keeping its pid, with `CCA_MODE=stream` and `CCA_PID` set to that pid.

`/account <name>` checks that `CCA_PID` is its own process, records `<name>` for the conversation, and sends its own process SIGINT from a zero-delay timer. In this mode SIGINT ends Claude Code with exit status 0, which the extension treats as a normal end (SIGTERM gives 143, which the panel reports as a failure). The panel then starts a new process at your next message, resuming the same conversation. The new process starts through the wrapper, which reads the record and picks `<name>`.

## Folder trust and MCP servers

Each account's `.claude.json` holds settings that cannot be linked, because the file also holds the account's login. Before every session starts, in a terminal and in VS Code, `libexec/cca-sync` gives the starting account what all accounts share:

- Folder trust: `projects[<path>].hasTrustDialogAccepted`. Claude Code treats a folder as trusted when it, or a folder above it up to the git repository's root, has that flag. A run without a terminal, as VS Code's are, does not ask: without the flag it skips what needs trust, such as an MCP server's `headersHelper` and the MCP servers and hooks an agent definition brings. Each account gets the union of all accounts' trust. Trust is only added, never removed.
- Per-project MCP settings: a project's local servers (`projects[<path>].mcpServers`) and the answers about its `.mcp.json` servers (`projects[<path>].enabledMcpjsonServers` and `disabledMcpjsonServers`). One added, changed or removed on any account is added, changed or removed on all of them.

`~/.claude.json` holds the shared copy of these. A change on another account has to be told apart from a copy that account has not caught up on, so `~/.claude-shared/accounts/sync-state.json` keeps, per account, a digest of each item as cca last saw it there. It holds digests only, never a server's command, URL or secrets. At each start, cca-sync applies every account's changes since its last sighting to the shared copy, then makes the starting account match it. An account seen for the first time adds what it has without replacing what is already shared. When two accounts change the same item, the starting account's change wins. `CCA_TRUST_SYNC=off` and `CCA_MCP_SYNC=off` turn each part off.

Running sessions write `.claude.json` often, so cca-sync writes the way Claude Code does:

- It takes Claude Code's lock on the shared copy and on the starting account's config: the directory `<config>.lock`, created with `mkdir` (the `proper-lockfile` convention). If a running session holds a lock for 3 seconds, cca-sync gives up, says so, and tries again at the next start. It never breaks a lock. One cca-sync runs at a time, under an OS lock on `sync-state.json.lock`.
- Under the lock it reads the file again, makes the change, writes a temporary file with the original permissions, syncs it to disk and renames it over the config.

Claude Code saves `.claude.json` by applying its change to a fresh read taken under the same lock, so a running session keeps what cca-sync added. It picks up new MCP servers at its next start.

A folder the account has never opened needs a new entry. Claude Code reads an entry as written, without filling in defaults, so a new entry must have every field Claude Code's own default entry has. cca-sync reads that default from the installed Claude Code binary (it is a literal, `{allowedTools:[],mcpContextUris:[],...,hasTrustDialogAccepted:!1,...}`), checks it holds only empty lists, empty objects and booleans, and caches it per binary in `~/.claude-shared/accounts/cache/`. If the literal is not there in that shape, cca-sync only changes folders the account already has entries for, and says so.

## User MCP servers in one file

User MCP servers live in `~/.claude-shared/mcp.json`, in the `{"mcpServers": {...}}` format `claude --mcp-config` reads. cca passes it to every session it starts, as `--mcp-config=<file>` before the other arguments: the option takes several values, and the `=` form leaves a prompt or subcommand after it alone. In VS Code it goes in front of the extension's own options, beside any `--mcp-config` of the extension's. The servers keep their names, so their tools are `mcp__<server>__<tool>` as before. Claude Code started some other way does not load the file.

`claude mcp add --scope user` writes to the account's `.claude.json`. At each start cca-sync moves every user server the starting account and `~/.claude.json` hold into the file and leaves those two configs holding none; it also takes in servers added or changed on the other accounts, which are emptied when they start. A server cca saw on an account before and that is unchanged there is a stale copy: it is not taken back into the file, so an edit or removal made in the file stands. The file is written before the configs lose their copies, created private (0600, it holds the servers' secrets), and never rewritten when it does not parse: then every server stays where it is until it is fixed. `CCA_MCP_SYNC=off` stops the moving; the file is still loaded.

## The plugin

`plugin/` is a Claude Code plugin, loaded in every session through `CLAUDE_CODE_PLUGIN_DIRS` in the env block of `~/.claude/settings.json` (which every account shares). It registers `/account`, shows the account in the status line, and records each conversation's account when a session starts. It reads cca's state directory from `CCA_ROOT`, which cca sets, or `~/.claude-shared/accounts`.

## Files cca writes

| Path | What |
|---|---|
| `~/.claude-shared/{projects,todos,file-history,sessions}` | The shared state, moved out of `~/.claude` by `cca init`. |
| `~/.claude-shared/accounts/accounts.tsv` | The accounts. |
| `~/.claude-shared/accounts/default` | The account new sessions start on. |
| `~/.claude-shared/accounts/share.conf` | What other accounts link from `~/.claude`. |
| `~/.claude-shared/accounts/by-session/<id>` | The account each conversation last ran on. |
| `~/.claude-shared/accounts/switch/<pid>` | A pending terminal switch, removed when cca exits. |
| `~/.claude-shared/accounts/cache/` | Claude Code's default project entry, per binary. |
| `~/.claude-shared/mcp.json` | The user MCP servers every session loads. |
| `~/.claude-shared/accounts/sync-state.json` | Per account, digests of its trust and MCP items as cca last saw them. |
| Your shell's startup file (`.zshrc`, `.bashrc` or fish's `config.fish`) | A block between `# >>> cc-accounts >>>` and `# <<< cc-accounts <<<`. |
| `~/.claude/settings.json` | `CLAUDE_CODE_PLUGIN_DIRS` in its `env` block. |
| Editor settings | `claudeCode.claudeProcessWrapper`, in each desktop editor's user settings and each remote editor server's machine settings (`~/.vscode-server/data/Machine/settings.json` and the like). |
| Each account's `.claude.json` | Trust flags and per-project MCP settings, user MCP servers moved out, as above, and the preferences below. |

`CCA_ROOT` moves the state directory and `CCA_SHARED` the shared one.

## Preferences the editor saves

VS Code's Claude in Chrome and memory dialogs save their settings by running the binary once, as `claude edit-chrome-settings` or `claude edit-memory-settings`, from the extension itself rather than from a session. That run goes through the process wrapper too, but names no conversation, so nothing says which panel's account asked, and the setting lives in each account's `.claude.json`. cca runs the helper on every account, feeding each the same input, so the setting reads the same everywhere, as a shared one. Without this the setting went to the default account, and a panel on another account kept reporting it off (Claude in Chrome then never connected there). A helper run from inside a session, where `CLAUDE_ACCOUNT` is set, or with `--resume`, runs on that account alone.

## What a Claude Code update can break

| Claude Code behavior | Used for | Caught by |
|---|---|---|
| `CLAUDE_CONFIG_DIR` selects the config directory | Every account | Running cca |
| `claude edit-chrome-settings` and `edit-memory-settings` write the account's `.claude.json` | Preferences the editor saves | `tests/cca.test.sh` (the fan-out), a VS Code `/chrome` toggle on a non-default account (the effect) |
| Credentials keyed per config directory | Separate logins | Running cca |
| `claude --help` option format | Keeping options on a switch | `tests/test_keep_args.py` against the installed Claude Code |
| The default project entry literal in the binary | New project entries | `tests/test_cca_sync.py` against the installed Claude Code |
| `.claude.json` lock, project layout and MCP fields | Folder trust and MCP servers | `tests/test_cca_sync.py` |
| `--mcp-config=<file>` before a prompt or subcommand, with server names kept in tool names | The shared MCP file | Manual check: a headless run lists `mcp__<server>__` tools |
| Claude Code saves `.claude.json` as a change to a fresh read under its lock | Synced items surviving running sessions | Manual check |
| A run without a terminal skips what needs trust unless the folder's flag is set | Trust synced before VS Code sessions | Manual check |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` names the folder holding `projects/<project>/memory` | Memory writes without a prompt | Manual check: a memory write in a headless run on a non-default account |
| Claude Code installs the plugins `settings.json` enables | Plugins on every account | Manual check |
| The extension's `claudeProcessWrapper` call (`wrapper <binary> <args>`), machine-scoped | VS Code | Manual check |
| SIGINT ending a stream-json session with status 0 | VS Code switch | Manual check |
| The plugin API | `/account` | `plugin/tests` with `claude plugin test` |

## Windows

cc-accounts runs in WSL, where Claude Code is a Linux program and everything above applies. Claude Code installed natively on Windows is not supported: cca is a bash script, the shared folders are symbolic links (which need Developer Mode or administrator rights on Windows), the terminal switch and the VS Code switch rely on POSIX processes and signals, and the extension cannot run a bash script as its process wrapper. Native support needs a port of cca to Python with directory junctions, a `.cmd` wrapper, and a different way to end the VS Code session; it is tracked in issue #1.
