#!/bin/bash
# A Claude Code subcommand run through cca starts no session, so it is given
# no session options: `claude plugin test` refuses any option before `plugin`.
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

args() { cut -d' ' -f3- "$LOG" | paste -sd'|' -; }
shared() { FILE="$HOME/.claude-shared/mcp.json"; echo '{"mcpServers":{}}' > "$FILE"; }

setup; shared
"$CCA" run plugin test dir
check "a subcommand is run as typed, with no option in front" "args=plugin test dir" "$(args)"
: > "$LOG"; "$CCA" 2 plugins list
check "so is a subcommand's other name, on a named account" "args=plugins list" "$(args)"
: > "$LOG"; "$CCA" run doctor
check "and a subcommand with nothing after it" "args=doctor" "$(args)"
: > "$LOG"; "$CCA" run "plugin the gap in the tests"
check "a prompt that starts with a subcommand's name is a session" \
  "args=--mcp-config=$FILE plugin the gap in the tests" "$(args)"
: > "$LOG"; "$CCA" run "fix it"
check "a prompt is a session and loads the shared file" "args=--mcp-config=$FILE fix it" "$(args)"
: > "$LOG"; "$CCA" run
check "no arguments is a session" "args=--mcp-config=$FILE" "$(args)"
: > "$LOG"; "$CCA" run -p doctor
check "a subcommand's name after an option is that option's prompt" "args=--mcp-config=$FILE -p doctor" "$(args)"

setup; shared
"$CCA" "$CCA_CLAUDE" edit-hook x < /dev/null
check "the editor's own subcommand, which --help does not list, is run as given" "args=edit-hook x" "$(args)"

finish
