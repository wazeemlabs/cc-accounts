# Shared by the shell tests: a throwaway HOME with two accounts, and a
# stand-in claude binary that records how cca ran it.
# shellcheck shell=bash
# CCA and ID are used by the test files that source this.
# shellcheck disable=SC2034

CCA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/cca"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
pass=0 fail=0
ID=0f4a6c1e-1111-4222-8333-944455556666

check() { # name, expected, actual
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"
  fi
}

finish() {
  echo "$(basename "$0"): $pass passed, $fail failed"
  [[ $fail -eq 0 ]]
}

setup() {
  export HOME="$WORK/home-$RANDOM$RANDOM"
  mkdir -p "$HOME/.claude" "$HOME/.claude-shared"/{projects,todos,file-history,sessions} "$HOME/.claude-two"
  echo '{}' > "$HOME/.claude/settings.json"
  echo '# shared' > "$HOME/.claude/CLAUDE.md"
  echo '{"oauthAccount":{"emailAddress":"one@example.com"}}' > "$HOME/.claude.json"
  echo '{"oauthAccount":{"emailAddress":"two@example.com"}}' > "$HOME/.claude-two/.claude.json"
  export CCA_ROOT="$HOME/.claude-shared/accounts"
  mkdir -p "$CCA_ROOT/by-session"
  printf '1\t%s\n2\t%s\n' "$HOME/.claude" "$HOME/.claude-two" > "$CCA_ROOT/accounts.tsv"
  LOG="$WORK/log-$RANDOM$RANDOM"; : > "$LOG"; export LOG
  # The stand-in records its account and args; with FAKE_SWITCH it asks for a
  # switch on its first run, as /account does. Its comment holds Claude Code's
  # default project entry, which cca-trust reads from the binary.
  export CCA_CLAUDE="$WORK/fake-claude"
  cat > "$CCA_CLAUDE" <<'FAKE'
#!/bin/bash
# var uhe={allowedTools:[],mcpContextUris:[],mcpServers:{},hasTrustDialogAccepted:!1};
if [[ "$1" == --help ]]; then cat "$FIXTURES/claude-help.txt"; exit 0; fi
stdin=""; case "$1" in edit-*) stdin="$(cat)" ;; esac
echo "dir=${CLAUDE_CONFIG_DIR-unset} account=${CLAUDE_ACCOUNT-} args=$*${stdin:+ stdin=$stdin}" >> "$LOG"
echo "mode=${CCA_MODE-} parent=$([[ "${CCA_PID-}" == "$PPID" ]] && echo yes || echo no) self=$([[ "${CCA_PID-}" == "$$" ]] && echo yes || echo no) root=${CCA_ROOT-}" >> "$LOG.pid"
echo "${CLAUDE_CODE_REMOTE_MEMORY_DIR-unset}" >> "$LOG.memory"
if [[ -n "${FAKE_SWITCH:-}" && ! -e "$LOG.switched" ]]; then
  touch "$LOG.switched"; echo "$FAKE_SWITCH" > "$CLAUDE_ACCOUNT_SWITCH_FILE"; exit 0
fi
exit "${FAKE_STATUS:-0}"
FAKE
  chmod +x "$CCA_CLAUDE"
  export FIXTURES
  # XDG_CONFIG_HOME would send config writes outside the throwaway HOME; the
  # rest are what a session started by cca passes to the tests it runs.
  unset CLAUDE_ACCOUNT CLAUDE_CONFIG_DIR FAKE_SWITCH FAKE_STATUS XDG_CONFIG_HOME \
    CLAUDE_CODE_REMOTE_MEMORY_DIR CCA_TRUST_SYNC CCA_MCP_SYNC CCA_MODE CCA_PID CLAUDE_ACCOUNT_SWITCH_FILE
}
