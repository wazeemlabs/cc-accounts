#!/bin/bash
# Tests for cca init, add after init, and cca uninstall, on a first-time
# user's ~/.claude in a throwaway HOME.
# Run: bash tests/init.test.sh
set -uo pipefail
# shellcheck source=tests/lib.sh
. "$(dirname "$0")/lib.sh"

REPO="$(cd "$(dirname "$CCA")/.." && pwd -P)"

# ~/.claude as Claude Code leaves it: its own conversations, a settings file
# with an env block, a shell rc with content, and two editors' settings.
fresh() {
  setup
  rm -rf "$HOME/.claude-shared" "$HOME/.claude-two"
  mkdir -p "$HOME/.claude/projects/-work" "$HOME/.claude/todos" "$HOME/.claude/sessions"
  echo '{"type":"user"}' > "$HOME/.claude/projects/-work/abc.jsonl"
  printf '{\n  "env": {\n    "A": "1"\n  },\n  "model": "opus"\n}\n' > "$HOME/.claude/settings.json"
  printf 'export EDITOR=vim\n' > "$HOME/.zshrc"
  export SHELL=/bin/zsh
  if [[ "$(uname)" == Darwin ]]; then EDITORS="$HOME/Library/Application Support"; else EDITORS="$HOME/.config"; fi
  mkdir -p "$EDITORS/Code/User" "$EDITORS/Cursor/User"
  printf '{\n    "editor.wordWrap": "on"\n}\n' > "$EDITORS/Code/User/settings.json"
  printf '{\n    // mine\n    "editor.wordWrap": "on",\n}\n' > "$EDITORS/Cursor/User/settings.json"
}

json() { # file, python expression over `d`
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"
}

fresh
out="$("$CCA" init main 2>&1)"; status=$?
check "init succeeds on a first-time ~/.claude" "0" "$status"
check "init moves ~/.claude's conversations into the shared dir and links them back" \
  "$HOME/.claude-shared/projects {\"type\":\"user\"}" \
  "$(readlink "$HOME/.claude/projects") $(cat "$HOME/.claude-shared/projects/-work/abc.jsonl")"
check "init links every shared state dir" \
  "$HOME/.claude-shared/todos $HOME/.claude-shared/file-history $HOME/.claude-shared/sessions" \
  "$(readlink "$HOME/.claude/todos") $(readlink "$HOME/.claude/file-history") $(readlink "$HOME/.claude/sessions")"
check "init registers ~/.claude under the name and makes it the default" \
  "main	$HOME/.claude main" "$(cat "$CCA_ROOT/accounts.tsv") $(cat "$CCA_ROOT/default")"
check "init writes the default share list" "settings.json CLAUDE.md agents commands keybindings.json" \
  "$(grep -v '^#' "$CCA_ROOT/share.conf" | paste -sd' ' -)"
check "init adds the shell block after the rc file's own lines" \
  "export EDITOR=vim|# >>> cc-accounts >>>|export PATH=\"$REPO/bin:\$PATH\"|claude() { cca run \"\$@\"; }" \
  "$(grep -v '^# Run\|^# it last' "$HOME/.zshrc" | grep -v '^$' | grep -v '<<<' | paste -sd'|' -)"
check "init loads the plugin through settings.json and keeps its other settings" \
  "{'A': '1', 'CLAUDE_CODE_PLUGIN_DIRS': '$REPO/plugin'} opus" \
  "$(json "$HOME/.claude/settings.json" "d['env'], d['model']")"
check "init keeps settings.json's indent" '  "env": {' "$(sed -n 2p "$HOME/.claude/settings.json")"
check "init points VS Code's extension at cca" "$REPO/bin/cca on" \
  "$(json "$EDITORS/Code/User/settings.json" "d['claudeCode.claudeProcessWrapper'], d['editor.wordWrap']")"
check "init leaves a settings file with comments alone" '    // mine' "$(sed -n 2p "$EDITORS/Cursor/User/settings.json")"
check "and prints the line to add to it" "1" "$(echo "$out" | grep -c 'leaves it as it is. Add this line')"

before="$(cat "$HOME/.zshrc" "$HOME/.claude/settings.json" "$EDITORS/Code/User/settings.json" | shasum)"
"$CCA" init main >/dev/null 2>&1; status=$?
check "init a second time changes nothing" "0 $before" \
  "$status $(cat "$HOME/.zshrc" "$HOME/.claude/settings.json" "$EDITORS/Code/User/settings.json" | shasum)"
check "and adds no second account row" "1" "$(wc -l < "$CCA_ROOT/accounts.tsv" | tr -d ' ')"

"$CCA" add work >/dev/null 2>&1
check "add links the shared conversations and sessions into the new account" \
  "$HOME/.claude-shared/projects $HOME/.claude-shared/sessions" \
  "$(readlink "$HOME/.claude-work/projects") $(readlink "$HOME/.claude-work/sessions")"
check "add links the share list's items that ~/.claude has, and only those" \
  "$HOME/.claude/settings.json $HOME/.claude/CLAUDE.md no" \
  "$(readlink "$HOME/.claude-work/settings.json") $(readlink "$HOME/.claude-work/CLAUDE.md") $([[ -e "$HOME/.claude-work/agents" ]] && echo yes || echo no)"

out="$("$CCA" uninstall 2>&1)"
check "uninstall removes the shell block and keeps the rest of the rc file" "export EDITOR=vim" "$(cat "$HOME/.zshrc")"
check "uninstall removes the plugin from settings.json and keeps the rest" "{'A': '1'} opus" \
  "$(json "$HOME/.claude/settings.json" "d['env'], d['model']")"
check "uninstall removes the VS Code wrapper" "False" \
  "$(json "$EDITORS/Code/User/settings.json" "'claudeCode.claudeProcessWrapper' in d")"
check "uninstall leaves accounts and conversations as they are" "2 $HOME/.claude-shared/projects" \
  "$(wc -l < "$CCA_ROOT/accounts.tsv" | tr -d ' ') $(readlink "$HOME/.claude/projects")"

"$CCA" init other >/dev/null 2>"$WORK/err"; status=$?
check "init under a second name for ~/.claude is refused, naming the first" "2 1" \
  "$status $(grep -c "already the account 'main'" "$WORK/err")"

fresh
echo "{\"pid\": $$}" > "$HOME/.claude/sessions/$$.json"
"$CCA" init main >/dev/null 2>"$WORK/err"; status=$?
check "init refuses while Claude Code runs" "2 1" "$status $(grep -c -- '--yes' "$WORK/err")"
check "and moves nothing" "no" "$([[ -L "$HOME/.claude/projects" ]] && echo yes || echo no)"
"$CCA" init main --yes >/dev/null 2>&1; status=$?
check "init --yes goes ahead" "0 $HOME/.claude-shared/projects" "$status $(readlink "$HOME/.claude/projects")"
echo "{\"pid\": $$}" > "$HOME/.claude/sessions/$$.json"
"$CCA" init main >/dev/null 2>&1; status=$?
check "init again while Claude Code runs goes ahead: there is nothing left to move" "0" "$status"

fresh
mkdir -p "$HOME/.claude-shared/projects/-other"
echo x > "$HOME/.claude-shared/projects/-other/x.jsonl"
"$CCA" init main >/dev/null 2>"$WORK/err"; status=$?
check "init stops when ~/.claude and the shared dir both hold conversations" "2 1" \
  "$status $(grep -c 'merge them by hand' "$WORK/err")"
check "and leaves both where they were" "no yes" \
  "$([[ -L "$HOME/.claude/projects" ]] && echo yes || echo no) $([[ -f "$HOME/.claude/projects/-work/abc.jsonl" ]] && echo yes || echo no)"

fresh
mkdir -p "$HOME/dotfiles" && mv "$HOME/.zshrc" "$HOME/dotfiles/zshrc" && ln -s "$HOME/dotfiles/zshrc" "$HOME/.zshrc"
"$CCA" init main >/dev/null 2>&1
check "a symlinked rc file stays a symlink, its target gets the block" "$HOME/dotfiles/zshrc 1" \
  "$(readlink "$HOME/.zshrc") $(grep -c '>>> cc-accounts >>>' "$HOME/dotfiles/zshrc")"

fresh
SHELL=/bin/tcsh "$CCA" init main > "$WORK/out" 2>&1
check "for a shell cca does not know, init prints the lines instead of editing a file" "1 export EDITOR=vim" \
  "$(grep -c 'Add these lines to its startup file' "$WORK/out") $(cat "$HOME/.zshrc")"

fresh
SHELL=/usr/bin/fish "$CCA" init main >/dev/null 2>&1
check "for fish, init writes fish syntax to config.fish" \
  "fish_add_path --global \"$REPO/bin\"|function claude; cca run \$argv; end" \
  "$(grep -E '^(fish_add_path|function)' "$HOME/.config/fish/config.fish" | paste -sd'|' -)"
SHELL=/usr/bin/fish "$CCA" uninstall >/dev/null 2>&1
check "and uninstall takes it out again" "0" "$(grep -c cc-accounts "$HOME/.config/fish/config.fish")"

fresh
mkdir -p "$HOME/.vscode-server/bin" "$EDITORS/Windsurf/User"
"$CCA" init main >/dev/null 2>&1
check "init sets the wrapper in a remote server's machine settings (WSL, SSH)" "$REPO/bin/cca" \
  "$(json "$HOME/.vscode-server/data/Machine/settings.json" "d['claudeCode.claudeProcessWrapper']")"
check "init sets it for an editor installed but never configured" "$REPO/bin/cca" \
  "$(json "$EDITORS/Windsurf/User/settings.json" "d['claudeCode.claudeProcessWrapper']")"
check "init leaves alone editors that are not installed" "no" \
  "$([[ -e "$EDITORS/VSCodium" || -e "$HOME/.cursor-server" ]] && echo yes || echo no)"
"$CCA" uninstall >/dev/null 2>&1
check "uninstall removes it from the remote machine settings" "False" \
  "$(json "$HOME/.vscode-server/data/Machine/settings.json" "'claudeCode.claudeProcessWrapper' in d")"

fresh
"$CCA" add work 2>"$WORK/err"; status=$?
check "add before init says to run init" "2 1" "$status $(grep -c 'cca init' "$WORK/err")"

fresh
printf '{ "env": ' > "$HOME/.claude/settings.json"
"$CCA" init main >/dev/null 2>"$WORK/err"; status=$?
check "init stops on a settings.json that does not parse, leaving it as it was" "1 1" \
  "$status $(grep -c 'is not valid JSON' "$WORK/err")"
check "the broken file is untouched" '{ "env": ' "$(cat "$HOME/.claude/settings.json")"
check "and nothing else changed" "no no" \
  "$([[ -L "$HOME/.claude/projects" ]] && echo yes || echo no) $([[ -f "$CCA_ROOT/accounts.tsv" ]] && echo yes || echo no)"

fresh
"$REPO/install.sh" main > "$WORK/out" 2>&1; status=$?
check "install.sh run from a clone uses it in place and runs init" \
  "0 $REPO/bin" "$status $(grep -o "PATH=\"[^:]*" "$HOME/.zshrc" | cut -d'"' -f2)"
"$REPO/install.sh" > "$WORK/out" 2>&1; status=$?
check "install.sh again without a name reports an update" "0 Updated. Your accounts and settings are unchanged." \
  "$status $(tail -1 "$WORK/out")"

fresh
mkdir -p "$WORK/winbin"
printf '#!/bin/sh\necho MINGW64_NT-10.0-26100\n' > "$WORK/winbin/uname" && chmod +x "$WORK/winbin/uname"
PATH="$WORK/winbin:$PATH" bash "$REPO/install.sh" main > "$WORK/out" 2>&1; status=$?
check "install.sh on Windows outside WSL says to use WSL, changing nothing" "1 1 no" \
  "$status $(grep -c 'inside WSL' "$WORK/out") $([[ -L "$HOME/.claude/projects" ]] && echo yes || echo no)"

if git -C "$REPO" rev-parse --verify --quiet HEAD >/dev/null; then
  fresh
  git clone --quiet --bare "$REPO" "$WORK/origin.git"
  CCA_REPO="$WORK/origin.git" CCA_REF="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" \
    CCA_HOME="$HOME/.local/share/cc-accounts" bash -s -- main < "$REPO/install.sh" > "$WORK/out" 2>&1
  status=$?
  check "install.sh piped to bash clones into CCA_HOME and runs init from there" \
    "0 $HOME/.local/share/cc-accounts/bin" "$status $(grep -o "PATH=\"[^:]*" "$HOME/.zshrc" | cut -d'"' -f2)"
  CCA_REPO="$WORK/origin.git" CCA_REF="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" \
    CCA_HOME="$HOME/.local/share/cc-accounts" bash -s < "$REPO/install.sh" > "$WORK/out" 2>&1
  check "running it again updates the clone and says so" "0 1" \
    "$? $(grep -c '^Updated\.' "$WORK/out")"
  # An annotated tag, as releases are: cloning one by name made git print notes.
  git -C "$WORK/origin.git" -c user.name=test -c user.email=test@example.com tag -a v9.9.9 -m "test release" HEAD
  fresh
  CCA_REPO="$WORK/origin.git" CCA_REF=v9.9.9 CCA_HOME="$HOME/.local/share/cc-accounts" \
    bash -s -- main < "$REPO/install.sh" > "$WORK/out" 2>&1
  check "install.sh installs a tag quietly" "0 0" "$? $(grep -c -i 'detached\|not a commit' "$WORK/out")"
fi

finish
