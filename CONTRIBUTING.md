# Contributing

Thanks for helping. Bug reports, fixes and new features are all welcome.

## Reporting a bug

Open an issue with the bug report form. Include `cca version`, `claude --version`, your OS, and whether it happened in a terminal or an editor. cc-accounts depends on parts of Claude Code that change between releases, so the Claude Code version matters most.

## Working on the code

```
bin/cca               the command, in bash (it must run on macOS's bash 3.2)
libexec/cca-keep-args which options a switch keeps, read from claude --help
libexec/cca-sync      folder trust and MCP server sync between accounts
libexec/cca-setup     init and uninstall's edits to rc, settings and editor files
plugin/               the /account Claude Code plugin (TypeScript)
tests/                shell and Python tests; plugin/tests holds the plugin's
docs/how-it-works.md  what cca does and which Claude Code behavior it relies on
```

Run the tests and the linter before opening a pull request:

```sh
make test   # shell, Python, and the plugin's tests where Claude Code is installed
make lint   # needs ShellCheck
```

The tests run cca against a stand-in `claude` in a throwaway home directory; they never touch your own accounts. Two Python tests also read your installed Claude Code (its `--help` and its default project entry) and are skipped where it is not installed.

## Guidelines

- Every change comes with tests. A bug fix starts with a test that fails without it.
- Test names say what is promised ("init refuses while Claude Code runs"), not how.
- Keep cca working on macOS's `/bin/bash` 3.2 and on Linux.
- Any new reliance on Claude Code behavior goes in the table at the end of `docs/how-it-works.md`, with the test that catches it changing.
- Write docs and messages in plain, direct English.

## Releasing

1. Update `VERSION`, `plugin/.claude-plugin/plugin.json` and `CHANGELOG.md`. The tests fail while the first two differ.
2. Merge to `main` with CI green.
3. Tag `vX.Y.Z` and publish a GitHub release with the changelog entry.
