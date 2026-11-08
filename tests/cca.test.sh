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

# The plugin publishes where a new session should start (accounts/start).
age() { # file, seconds ago
  python3 -I -c 'import os, sys, time; t = time.time() - float(sys.argv[2]); os.utime(sys.argv[1], (t, t))' "$1" "$2"
}

setup
echo 1 > "$CCA_ROOT/default"; age "$CCA_ROOT/default" 600
echo 2 > "$CCA_ROOT/start"
"$CCA" run -p hi
check "a new session starts where the plugin's fresh choice says" "dir=$HOME/.claude-two account=2 args=-p hi" "$(cat "$LOG")"

setup
echo 2 > "$CCA_ROOT/start"; age "$CCA_ROOT/start" 600
echo 1 > "$CCA_ROOT/default"
"$CCA" run
check "a default set after the choice wins until the plugin chooses again" "dir=unset account=1 args=" "$(cat "$LOG")"

setup
echo 2 > "$CCA_ROOT/start"; age "$CCA_ROOT/start" 7200
"$CCA" run
check "a choice over an hour old is not trusted" "dir=unset account=1 args=" "$(cat "$LOG")"

setup
echo gone > "$CCA_ROOT/start"
"$CCA" run
check "a choice naming an account no longer in the table is passed over" "dir=unset account=1 args=" "$(cat "$LOG")"

setup
echo 2 > "$CCA_ROOT/start"
echo 1 > "$CCA_ROOT/by-session/$ID"
"$CCA" run --resume "$ID"
check "a resumed conversation keeps to the account it last ran on" "dir=unset account=1 args=--resume $ID" "$(cat "$LOG")"

setup
echo 2 > "$CCA_ROOT/start"
out="$("$CCA")"
check "list marks where new sessions start, and says the default is low" \
  "* 2|* new sessions start here; 1, the default, is low on room. Move a running one with /account <name>." \
  "$(echo "$out" | sed -n 2p | awk '{print $1, $2}')|$(echo "$out" | tail -1)"

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
FAKE_SWITCH=$'2 '"$ID"$'\nCarry on from where you stopped.' "$CCA" run --model opus 2>/dev/null
check "a switch that carries a follow-up reopens the conversation with it as the first prompt" \
  "dir=$HOME/.claude-two account=2 args=--model opus --resume $ID Carry on from where you stopped." "$(sed -n 2p "$LOG")"

setup
mkdir -p "$HOME/.claude-three" "$CCA_ROOT/usage" "$CCA_ROOT/blocked/2"
printf '3\t%s\n' "$HOME/.claude-three" >> "$CCA_ROOT/accounts.tsv"
echo '{}' > "$CCA_ROOT/usage/2.json"; echo '{}' > "$CCA_ROOT/blocked/2/account.json"; echo '{}' > "$CCA_ROOT/usage/3.json"
out="$("$CCA" remove 2)"
check "remove takes the account out of the table and leaves the others in order" \
  "1 3" "$(cut -f1 "$CCA_ROOT/accounts.tsv" | paste -sd' ' -)"
check "and drops what was kept of it, and nothing of the others" \
  "usage/3.json" "$(cd "$CCA_ROOT" && find usage blocked -type f | paste -sd' ' -)"
check "and leaves its folder and login, saying how to bring it back" \
  "Removed 2. Its folder $HOME/.claude-two is left as it is: cca add 2 $HOME/.claude-two brings it back. yes" \
  "$out $([[ -f "$HOME/.claude-two/.claude.json" ]] && echo yes)"

setup
"$CCA" use 2 >/dev/null
out="$("$CCA" remove 2 2>&1)"; status=$?
check "remove refuses the account new sessions start on" \
  "2 cca: new sessions start on 2; run cca use <another account> first" "$status $out"
check "remove refuses ~/.claude, which the others link" \
  "cca: 1 is $HOME/.claude, which every account links its settings from; it cannot be removed" "$("$CCA" remove 1 2>&1)"
check "remove refuses a name that is no account, leaving the table as it was" \
  "2 1 2" "$("$CCA" remove nobody >/dev/null 2>&1; echo $?) $(cut -f1 "$CCA_ROOT/accounts.tsv" | paste -sd' ' -)"

setup
mkdir -p "$CCA_ROOT/background" "$CCA_ROOT/blocked/2" "$CCA_ROOT/blocked/old"
echo '{"tasks":[]}' > "$CCA_ROOT/background/old"; echo '{"tasks":[]}' > "$CCA_ROOT/background/new"
echo '{"error":"rate_limit","at":0}' > "$CCA_ROOT/blocked/old/fable.json"
echo '{"error":"rate_limit","at":0}' > "$CCA_ROOT/blocked/2/fable.json"
touch -t 202001010000 "$CCA_ROOT/background/old" "$CCA_ROOT/blocked/old/fable.json"
"$CCA" run 2>/dev/null
check "a session start drops day-old background and failure records, and the folders they leave empty" \
  "background/new blocked/2/fable.json 0" \
  "$(cd "$CCA_ROOT" && find background blocked -type f | sort | paste -sd' ' -) $(cd "$CCA_ROOT" && find blocked -mindepth 1 -type d -empty | wc -l | tr -d ' ')"

setup
"$CCA" "$CCA_CLAUDE" --input-format stream-json < /dev/null
check "a VS Code session runs under cca-stream, which hands Claude Code a switch file" \
  "switch=set child=unset" "$(cat "$LOG.switchfile")"

setup
"$CCA" "$CCA_CLAUDE" --input-format=stream-json < /dev/null
check "and so does one that spells the input format with =" "switch=set child=unset" "$(cat "$LOG.switchfile")"

setup
"$CCA" "$CCA_CLAUDE" --output-format stream-json --resume "$ID" < /dev/null
check "a run of the wrapper that reads no stream-json, as a terminal's does, runs Claude Code itself" \
  "switch= child=unset" "$(cat "$LOG.switchfile")"

setup
echo 2 > "$CCA_ROOT/by-session/$ID"
# The panel keeps stdin open for the session's life: a FIFO this shell holds
# open for reading and writing never reaches end of file.
mkfifo "$WORK/panel"; exec 3<>"$WORK/panel"
FAKE_SWITCH="2 $ID" "$CCA" "$CCA_CLAUDE" --input-format stream-json <&3 2>"$WORK/err"; status=$?
exec 3>&-; rm -f "$WORK/panel"
check "a switch in a VS Code session reopens the conversation on the new account behind the same wrapper" \
  "dir=unset account=1 args=--input-format stream-json|dir=$HOME/.claude-two account=2 args=--input-format stream-json --resume $ID" \
  "$(paste -sd'|' "$LOG")"
check "and the wrapper exits with the reopened run's status" "0" "$status"
check "and says what it did" "cca: resuming $ID on account 2" "$(cat "$WORK/err")"
check "and leaves no switch file behind" "0" "$(find "$CCA_ROOT/switch" -type f | wc -l | tr -d ' ')"

setup
FAKE_STATUS=6 "$CCA" "$CCA_CLAUDE" --input-format stream-json < /dev/null; status=$?
check "a VS Code session that ends with no switch request exits with Claude Code's status" "6" "$status"

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

setup
mkdir -p "$CCA_ROOT/background"
echo '{"tasks":[]}' > "$CCA_ROOT/background/$ID"
echo '{"tasks":[]}' > "$CCA_ROOT/background/aaaaaaaa-1111-4222-8333-944455556666"
touch -t 202001010000 "$CCA_ROOT/background/aaaaaaaa-1111-4222-8333-944455556666"
"$CCA" run
check "a terminal run drops background-work records older than a day" "$ID" "$(ls "$CCA_ROOT/background")"

setup
mkdir -p "$CCA_ROOT/background"
echo '{"tasks":[]}' > "$CCA_ROOT/background/aaaaaaaa-1111-4222-8333-944455556666"
touch -t 202001010000 "$CCA_ROOT/background/aaaaaaaa-1111-4222-8333-944455556666"
"$CCA" "$CCA_CLAUDE" --resume "$ID"
check "a VS Code session start drops them too" "" "$(ls "$CCA_ROOT/background")"

check "help prints the usage block" "cca: run Claude Code on several accounts and move a conversation between them." "$("$CCA" help | head -1)"
check "help ends at the end of the comment block" "stops it)." "$("$CCA" help | tail -1)"
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
  FILE="$HOME/.claude-shared/mcp.json"
  python3 - "$HOME/.claude.json" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
config.update(mcpServers={'fetch': {'command': 'fetcher'}}, projects={'/x': {'hasTrustDialogAccepted': True}})
json.dump(config, open(sys.argv[1], 'w'))
PY
}
synced() { # the servers ~/.claude and account 2 hold, the shared file's, and whether account 2 trusts /x
  python3 -c "
import json, os, sys
home, two, shared = (json.load(open(p)) if os.path.exists(p) else None for p in sys.argv[1:])
print(sorted(home.get('mcpServers', {})), sorted(two.get('mcpServers', {})),
      sorted(shared['mcpServers']) if shared else None, two.get('projects', {}).get('/x', {}).get('hasTrustDialogAccepted'))" \
    "$HOME/.claude.json" "$HOME/.claude-two/.claude.json" "$FILE"
}

mcp_setup
"$CCA" 2 -p x 2>"$WORK/err"
check "a terminal start moves the user MCP servers into the shared file and syncs trust" "[] [] ['fetch'] True" "$(synced)"
check "and says so" "cca: MCP servers moved to $FILE, which every account loads: fetch" "$(grep MCP "$WORK/err")"
check "and the session loads the shared file" "dir=$HOME/.claude-two account=2 args=--mcp-config=$FILE -p x" "$(cat "$LOG")"

mcp_setup
echo 2 > "$CCA_ROOT/by-session/$ID"
"$CCA" "$CCA_CLAUDE" --output-format stream-json --resume "$ID" 2>/dev/null
check "a VS Code session start does the same" "[] [] ['fetch'] True" "$(synced)"
check "and loads the shared file ahead of the extension's own options" \
  "dir=$HOME/.claude-two account=2 args=--mcp-config=$FILE --output-format stream-json --resume $ID" "$(cat "$LOG")"

mcp_setup
CLAUDE_ACCOUNT=2 "$CCA" "$CCA_CLAUDE" plugin list --json 2>/dev/null
check "a Claude Code subcommand run through the wrapper syncs nothing and loads nothing" \
  "['fetch'] [] None None|account=2 args=plugin list --json" "$(synced)|$(cut -d' ' -f2- "$LOG")"

mcp_setup
FAKE_SWITCH="1 $ID" "$CCA" 2 --model opus 2>/dev/null
check "a relaunch after a switch loads the shared file once" \
  "args=--mcp-config=$FILE --model opus|args=--mcp-config=$FILE --model opus --resume $ID" "$(cut -d' ' -f3- "$LOG" | paste -sd'|' -)"

mcp_setup
CCA_MCP_SYNC=off "$CCA" 2 2>/dev/null
check "CCA_MCP_SYNC=off leaves MCP servers where they are and still syncs trust" "['fetch'] [] None True" "$(synced)"

mcp_setup
mkdir -p "$(dirname "$FILE")" && echo '{"mcpServers":{}}' > "$FILE"
CCA_MCP_SYNC=off "$CCA" 2 2>/dev/null
check "with CCA_MCP_SYNC=off a session still loads the shared file" "args=--mcp-config=$FILE" "$(cut -d' ' -f3- "$LOG")"

mcp_setup
CCA_MCP_SYNC=off CCA_TRUST_SYNC=off "$CCA" 2 2>/dev/null
check "with both syncs off nothing is synced" "['fetch'] [] None None" "$(synced)"

# cca spend: a client outside Claude Code counts its calls in the day's spend.
spend_record() { # account, project
  local digest day
  digest="$(printf '%s' "$2" | shasum -a 256 | cut -c1-12)"
  day="$(date -u +%F)"
  cat "$CCA_ROOT/spend/$day/client-$1-$digest.json" 2>/dev/null
}

setup
"$CCA" spend claude-opus-5-5 100 10 1000 40 --project /work/legal --account 2
"$CCA" spend claude-opus-5-5 1 2 3 4 --project /work/legal --account two@example.com
"$CCA" spend claude-sonnet-5-5 5 0 0 0 --account 2 --project /work/legal/
check "spend sums one call's raw counts per model, by name or email, into the account's record for the project" \
  '{"cwd": "/work/legal", "account": "2", "usage": {"claude-opus-5-5": {"input_tokens": 101, "output_tokens": 12, "cache_read_input_tokens": 1003, "cache_creation_input_tokens": 44}, "claude-sonnet-5-5": {"input_tokens": 5, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}}' \
  "$(spend_record 2 /work/legal)"

setup
out="$("$CCA" spend claude-opus-5-5 1 1 1 1 --project /work --account nobody 2>&1)"; status=$?
check "spend refuses an account no name or email matches" "2 cca: no account is named or signed in as 'nobody'" "$status $out"

setup
"$CCA" spend claude-opus-5-5 1 x 1 1 --project /work --account 1 2>/dev/null; status=$?
check "spend refuses a count that is not a whole number" "2 " "$status $(ls "$CCA_ROOT/spend" 2>/dev/null)"

setup
"$CCA" spend claude-opus-5-5 1 1 1 1 --project work --account 1 2>/dev/null; status=$?
check "spend refuses a project that is not an absolute folder" "2" "$status"

setup
"$CCA" spend 'opus; rm' 1 1 1 1 --project /work --account 1 2>/dev/null; status=$?
check "spend refuses a model that is not a model id" "2" "$status"

setup
"$CCA" spend claude-opus-5-5 1 1 1 1 --project /work 2>/dev/null; status=$?
check "spend without an account is refused" "2" "$status"

setup
"$CCA" spend some-new-model 7 0 0 0 --project /work --account 1; status=$?
check "spend keeps a model it does not know, for the plugin to weigh as it weighs any unknown model" \
  "0 7" "$status $(spend_record 1 /work | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["usage"]["some-new-model"]["input_tokens"])')"

setup
for _ in $(seq 1 20); do "$CCA" spend claude-opus-5-5 1 0 0 0 --project /work --account 1 & done; wait
check "spend calls running at once all count" "20" \
  "$(spend_record 1 /work | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["usage"]["claude-opus-5-5"]["input_tokens"])')"

finish
