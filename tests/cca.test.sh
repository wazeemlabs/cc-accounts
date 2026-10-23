#!/bin/bash
# Tests for bin/cca: choosing, launching and switching accounts, adding them,
# and syncing folder trust, against a stand-in claude in a throwaway HOME.
# Run: bash tests/cca.test.sh
set -uo pipefail
# shellcheck source=tests/lib.sh
. "$(dirname "$0")/lib.sh"

setup
out="$("$CCA")"
check "list marks the first account default and shows emails" \
  "* 1 one@example.com" "$(echo "$out" | sed -n 1p | awk '{print $1, $2, $3}')"
check "list shows the second account" "2 two@example.com" "$(echo "$out" | sed -n 2p | awk '{print $1, $2}')"

setup
"$CCA" run -p hi
check "run with no recorded account starts on the default, CLAUDE_CONFIG_DIR unset for ~/.claude" \
  "dir=unset account=1 args=-p hi" "$(cat "$LOG")"

setup
"$CCA" 2 --model opus
check "an explicit account sets its config dir and passes the args through" \
  "dir=$HOME/.claude-two account=2 args=--model opus" "$(cat "$LOG")"

setup
echo 2 > "$CCA_ROOT/by-session/$ID"
"$CCA" run --resume "$ID"
check "resume picks the account the conversation last ran on" \
  "dir=$HOME/.claude-two account=2 args=--resume $ID" "$(cat "$LOG")"

setup
echo 2 > "$CCA_ROOT/by-session/$ID"
"$CCA" run "--resume=$ID"
check "resume in --resume=<id> form" "dir=$HOME/.claude-two account=2 args=--resume=$ID" "$(cat "$LOG")"

setup
echo 2 > "$CCA_ROOT/by-session/$ID"
"$CCA" 1 --resume "$ID"
check "an explicit account beats the recorded one" "dir=unset account=1 args=--resume $ID" "$(cat "$LOG")"

setup
echo gone > "$CCA_ROOT/by-session/$ID"
"$CCA" run -r "$ID"
check "a recorded account no longer in the table falls back to the default" \
  "dir=unset account=1 args=-r $ID" "$(cat "$LOG")"

setup
"$CCA" use 2 >/dev/null
"$CCA" run
check "use changes the account new sessions start on" "dir=$HOME/.claude-two account=2 args=" "$(cat "$LOG")"

setup
"$CCA" use nope 2>/dev/null; status=$?
check "use refuses an unknown account" "2 1" "$status $(cat "$CCA_ROOT/default" 2>/dev/null || echo 1)"

setup
"$CCA" nope 2>/dev/null; status=$?
check "an unknown account is refused without running claude" "2 0" "$status $(wc -l < "$LOG" | tr -d ' ')"

setup
FAKE_SWITCH="2 $ID" FAKE_STATUS=7 "$CCA" run 2>/dev/null; status=$?
check "a switch request resumes the conversation on the new account" \
  "dir=unset account=1 args=|dir=$HOME/.claude-two account=2 args=--resume $ID" "$(paste -sd'|' "$LOG")"
check "the relaunched run's exit status is cca's" "7" "$status"
check "the switch file is gone afterwards" "0" "$(find "$CCA_ROOT/switch" -type f | wc -l | tr -d ' ')"

setup
FAKE_SWITCH="2 $ID" "$CCA" run --model opus --add-dir /a /b -w feat "fix it" 2>"$WORK/err"
check "a switch keeps the session's flags and drops its prompt and one-shot options" \
  "dir=$HOME/.claude-two account=2 args=--model opus --add-dir /a /b --resume $ID" "$(sed -n 2p "$LOG")"
check "a switch says what it did not carry over" "cca: not carried over: -w feat fix it" "$(grep 'not carried' "$WORK/err")"

setup
"$CCA" run
check "a terminal run tells the plugin it is the parent, and where state is" \
  "mode=terminal parent=yes self=no root=$CCA_ROOT" "$(cat "$LOG.pid")"

setup
"$CCA" "$CCA_CLAUDE" --resume "$ID"
check "a VS Code run tells the plugin it is this process" \
  "mode=stream parent=no self=yes root=$CCA_ROOT" "$(cat "$LOG.pid")"

setup
FAKE_SWITCH="nope $ID" "$CCA" run 2>/dev/null; status=$?
check "a malformed switch request stops with an error, not a relaunch" "2 1" "$status $(wc -l < "$LOG" | tr -d ' ')"

setup
FAKE_STATUS=3 "$CCA" run; status=$?
check "without a switch request cca exits with claude's status" "3" "$status"

setup
echo 2 > "$CCA_ROOT/by-session/$ID"
CLAUDE_ACCOUNT_SWITCH_FILE='' "$CCA" "$CCA_CLAUDE" --resume "$ID" --input-format stream-json
check "wrapper mode runs the given binary once on the recorded account" \
  "dir=$HOME/.claude-two account=2 args=--resume $ID --input-format stream-json" "$(cat "$LOG")"

setup
out="$(echo '{"on":true}' | "$CCA" "$CCA_CLAUDE" edit-chrome-settings --json)"
check "an editor's preference edit, naming no conversation, runs on every account with the same input" \
  "dir=unset account=1 args=edit-chrome-settings --json stdin={\"on\":true}|dir=$HOME/.claude-two account=2 args=edit-chrome-settings --json stdin={\"on\":true}" "$(paste -sd'|' "$LOG")"
check "and prints one result" "" "$out"

setup
echo '{}' | FAKE_STATUS=4 "$CCA" "$CCA_CLAUDE" edit-memory-settings --json; status=$?
check "a preference edit that fails on an account stops there with its status" \
  "4 1" "$status $(wc -l < "$LOG" | tr -d ' ')"

setup
echo '{}' | CLAUDE_ACCOUNT=2 "$CCA" "$CCA_CLAUDE" edit-chrome-settings --json
check "a preference edit from inside a session runs on that session's account only" \
  "dir=$HOME/.claude-two account=2 args=edit-chrome-settings --json stdin={}" "$(cat "$LOG")"

setup
CLAUDE_ACCOUNT=2 "$CCA" run -p x
check "an inherited CLAUDE_ACCOUNT (claude run inside a session) keeps that account" \
  "dir=$HOME/.claude-two account=2 args=-p x" "$(cat "$LOG")"

setup
rm "$CCA_ROOT/accounts.tsv"
CLAUDE_CONFIG_DIR=/keep "$CCA" run -p x
check "with no accounts registered claude runs untouched" "dir=/keep account= args=-p x memory=unset" \
  "$(cat "$LOG") memory=$(cat "$LOG.memory")"

setup
"$CCA" 2 -p x
"$CCA" "$CCA_CLAUDE" --resume "$ID"
check "every session, terminal or VS Code, keeps its memory at the shared conversations' real path" \
  "$HOME/.claude-shared|$HOME/.claude-shared" "$(paste -sd'|' "$LOG.memory")"

setup
: > "$CCA_ROOT/accounts.tsv"
echo '{}' | "$CCA" "$CCA_CLAUDE" edit-chrome-settings --json; status=$?
check "with an empty account table a preference edit runs once, untouched" \
  "0 dir=unset account= args=edit-chrome-settings --json stdin={}" "$status $(cat "$LOG")"

setup
"$CCA" add other "$HOME/.claude-two" 2>"$WORK/err"; status=$?
check "add refuses a folder another account already uses" "2 1 0" \
  "$status $(grep -c "already the account '2'" "$WORK/err") $(grep -c '^other' "$CCA_ROOT/accounts.tsv")"

check "the plugin's version is the release's" "$(cat "$(dirname "$CCA")/../VERSION")" \
  "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$(dirname "$CCA")/../plugin/.claude-plugin/plugin.json")"

setup
mkdir -p "$HOME/.claude-old" && echo '{"oauthAccount":{"emailAddress":"old@example.com"}}' > "$HOME/.claude-old/.claude.json"
echo '{"mine":true}' > "$HOME/.claude-old/settings.json"
"$CCA" add old "$HOME/.claude-old" >/dev/null 2>&1; status=$?
check "add adopts an existing dir" "0" "$status"
check "add links the shared settings" "$HOME/.claude/settings.json" "$(readlink "$HOME/.claude-old/settings.json")"
check "add keeps the account's own settings as a backup" '{"mine":true}' "$(cat "$HOME"/.claude-old/settings.json.bak-*)"
check "add links the shared conversations" "$HOME/.claude-shared/projects" "$(readlink "$HOME/.claude-old/projects")"
"$CCA" add old "$HOME/.claude-old" >/dev/null 2>&1
check "add is idempotent: one row, one backup" "1 1" \
  "$(grep -c '^old' "$CCA_ROOT/accounts.tsv") $(find "$HOME/.claude-old" -maxdepth 1 -name 'settings.json.bak-*' | wc -l | tr -d ' ')"

setup
"$CCA" add three >/dev/null 2>&1
check "add of an account with no login starts claude on it to sign in" \
  "dir=$HOME/.claude-three account=three args=" "$(cat "$LOG")"

setup
"$CCA" add run 2>/dev/null; s1=$?
"$CCA" add 'Bad Name' 2>/dev/null; s2=$?
"$CCA" add 2 "$HOME/elsewhere" 2>/dev/null; s3=$?
check "add refuses a command name, a malformed name and a name taken by another dir" "2 2 2" "$s1 $s2 $s3"

setup
echo 2 > "$CCA_ROOT/by-session/$ID"
echo 2 > "$CCA_ROOT/by-session/aaaaaaaa-1111-4222-8333-944455556666"
touch -t 202001010000 "$CCA_ROOT/by-session/aaaaaaaa-1111-4222-8333-944455556666"
"$CCA" run
check "a terminal run drops records older than RECORD_DAYS and keeps fresh ones" "$ID" "$(ls "$CCA_ROOT/by-session")"

check "help prints the usage block" "cca: run Claude Code on several accounts and move a conversation between them." "$("$CCA" help | head -1)"
check "help ends at the end of the comment block" "next message you send continues it on <name>." "$("$CCA" help | tail -1)"
check "version prints the release" "cca $(cat "$(dirname "$CCA")/../VERSION")" "$("$CCA" version)"

setup
python3 - "$HOME" <<'PY'
import json, sys
home = sys.argv[1]
for path, projects in [(f'{home}/.claude.json', {'/x': {'hasTrustDialogAccepted': True}}),
                       (f'{home}/.claude-two/.claude.json', {})]:
    config = json.load(open(path)); config['projects'] = projects; json.dump(config, open(path, 'w'))
PY
"$CCA" 2 2>"$WORK/err"
check "a launch gives the account the folders another account trusts" "True []" \
  "$(python3 -c "import json,sys;e=json.load(open(sys.argv[1]))['projects']['/x'];print(e['hasTrustDialogAccepted'],e['allowedTools'])" "$HOME/.claude-two/.claude.json")"
check "and says so" "cca: trusted 1 folder(s) another account trusts: /x" "$(cat "$WORK/err")"
python3 -c "import json,sys;p=sys.argv[1];c=json.load(open(p));c['projects']['/y']={'hasTrustDialogAccepted':True};json.dump(c,open(p,'w'))" "$HOME/.claude.json"
CCA_TRUST_SYNC=off "$CCA" 2 2>/dev/null
check "CCA_TRUST_SYNC=off leaves trust alone" "False" \
  "$(python3 -c "import json,sys;print('/y' in json.load(open(sys.argv[1]))['projects'])" "$HOME/.claude-two/.claude.json")"
FAKE_SWITCH="1 $ID" "$CCA" 2 2>"$WORK/err"
check "a launch syncs what it finds and a relaunch with nothing new is silent" \
  "cca: trusted 1 folder(s) another account trusts: /y|cca: resuming $ID on account 1" "$(paste -sd'|' "$WORK/err")"

# ~/.claude's account has an MCP server and trusts /x; account 2 has neither.
mcp_setup() {
  setup
  python3 - "$HOME/.claude.json" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
config.update(mcpServers={'fetch': {'command': 'fetcher'}}, projects={'/x': {'hasTrustDialogAccepted': True}})
json.dump(config, open(sys.argv[1], 'w'))
PY
}
synced() { # what account 2's config holds: its MCP servers and whether it trusts /x
  python3 -c "import json,sys;c=json.load(open(sys.argv[1]));print(sorted(c.get('mcpServers',{})),c.get('projects',{}).get('/x',{}).get('hasTrustDialogAccepted'))" \
    "$HOME/.claude-two/.claude.json"
}

mcp_setup
"$CCA" 2 2>"$WORK/err"
check "a terminal launch gives the account the MCP servers another account has" "['fetch'] True" "$(synced)"
check "and says so" "cca: MCP servers from the other accounts: added fetch" "$(grep MCP "$WORK/err")"

mcp_setup
echo 2 > "$CCA_ROOT/by-session/$ID"
"$CCA" "$CCA_CLAUDE" --output-format stream-json --resume "$ID" 2>/dev/null
check "a VS Code session start gives its account the MCP servers and trust the others have" "['fetch'] True" "$(synced)"

mcp_setup
CLAUDE_ACCOUNT=2 "$CCA" "$CCA_CLAUDE" plugin list --json 2>/dev/null
check "a Claude Code subcommand run through the wrapper syncs nothing" "[] None" "$(synced)"

mcp_setup
CCA_MCP_SYNC=off "$CCA" 2 2>/dev/null
check "CCA_MCP_SYNC=off leaves MCP servers alone and still syncs trust" "[] True" "$(synced)"

mcp_setup
CCA_MCP_SYNC=off CCA_TRUST_SYNC=off "$CCA" 2 2>/dev/null
check "with both syncs off nothing is synced" "[] None" "$(synced)"

finish
