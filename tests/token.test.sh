#!/bin/bash
# cca token: an account's long-lived token (claude setup-token), kept in the
# machine's secret store and given to Claude Code when the account runs.
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TOKEN=sk-ant-oat01-abcDEF_123-xyz4567890123456
OTHER=sk-ant-oat01-zzzYYY_987-www6543210987654
login() { cut -d' ' -f1 "$LOG.login" | paste -sd' ' -; }

setup; export CCA_TOKEN_STORE=file
out="$(printf '%s\n' "$TOKEN" | "$CCA" token 2 2>&1)"; status=$?
check "token keeps the token read from stdin and says what the account now runs on" \
  "0 Account 2 now runs on its long-lived token, not its /login." "$status $(echo "$out" | head -1)"
check "and never prints it" "0" "$(echo "$out" | grep -c "$TOKEN")"
check "the file store keeps it readable by the owner alone" "600 700" \
  "$(python3 -I -c 'import os,sys; print(*(oct(os.stat(p).st_mode & 0o777)[2:] for p in sys.argv[1:]))' "$CCA_ROOT/tokens/2" "$CCA_ROOT/tokens")"
"$CCA" 2 -p x
check "the account's session is given its token" "token=$TOKEN" "$(login)"
: > "$LOG.login"; "$CCA" 1 -p x
check "an account with no token runs on its own login" "token=unset" "$(login)"
: > "$LOG.login"; CLAUDE_CODE_OAUTH_TOKEN=host-token "$CCA" 2 -p x
check "the account's token replaces one a host left in the environment" "token=$TOKEN" "$(login)"
: > "$LOG.login"; CLAUDE_ACCOUNT=2 "$CCA" "$CCA_CLAUDE" -p x
check "a run through the editor's wrapper is given it too" "token=$TOKEN" "$(login)"
: > "$LOG.login"; FAKE_SWITCH="1 $ID" "$CCA" 2 -p x 2>/dev/null
check "a switch to an account with no token drops it" "token=$TOKEN token=unset" "$(login)"
check "the list marks the account that runs on a token" "2" \
  "$("$CCA" | awk '/long-lived token/ { print ($1 == "*" ? $2 : $1) }' | paste -sd' ' -)"
printf '%s\n' "$OTHER" | "$CCA" token 2 >/dev/null
: > "$LOG.login"; "$CCA" 2 -p x
check "a second token replaces the first" "token=$OTHER" "$(login)"
out="$("$CCA" token 2 --remove)"
: > "$LOG.login"; "$CCA" 2 -p x
check "token --remove puts the account back on its /login" \
  "Account 2 runs on its /login again. token=unset no" \
  "$out $(login) $([[ -e "$CCA_ROOT/tokens/2" ]] && echo yes || echo no)"
out="$("$CCA" token 2 --remove 2>&1)"; status=$?
check "removing a token that is not there is refused" "2 cca: 2 has no token" "$status $out"

setup; export CCA_TOKEN_STORE=file
out="$(printf 'hello world\n' | "$CCA" token 2 2>&1)"; status=$?
check "what is not a setup-token token is refused and nothing is kept" \
  "2 cca: that is not a token from claude setup-token (it starts sk-ant-oat) no" \
  "$status $out $([[ -e "$CCA_ROOT/tokens/2" ]] && echo yes || echo no)"
out="$(printf '\n' | "$CCA" token 2 2>&1)"; status=$?
check "an empty line is refused" "2 cca: that is not a token from claude setup-token (it starts sk-ant-oat)" "$status $out"
check "an unknown account is refused" "2" "$(printf '%s\n' "$TOKEN" | "$CCA" token nobody >/dev/null 2>&1; echo $?)"
out="$("$CCA" token 2>&1)"; status=$?
check "token needs a name" "2 cca: usage: cca token <name> [--remove]" "$status $out"
out="$(printf '%s\n' "$TOKEN" | "$CCA" token 2 --drop 2>&1)"; status=$?
check "an option that is not --remove is refused" "2 cca: usage: cca token <name> [--remove]" "$status $out"
check "'token' cannot name an account" "2" "$("$CCA" add token >/dev/null 2>&1; echo $?)"

setup; export CCA_TOKEN_STORE=file
printf '%s\n' "$TOKEN" | "$CCA" token 2 >/dev/null
"$CCA" remove 2 >/dev/null
check "removing an account drops its token" "no" "$([[ -e "$CCA_ROOT/tokens/2" ]] && echo yes || echo no)"

# The macOS Keychain, through a stand-in `security` that records how it was
# run: the token goes in on stdin, never as an argument another process
# could read from the process list.
setup; export CCA_TOKEN_STORE=keychain
mkdir -p "$WORK/bin" "$WORK/chain"
cat > "$WORK/bin/security" <<'FAKE'
#!/bin/bash
echo "$*" >> "$CHAIN/argv"
entry() { local a="" prev=""; for x in "$@"; do [[ "$prev" == -a ]] && a="$x"; prev="$x"; done; echo "$CHAIN/entry-$a"; }
case "$1" in
  -i) read -r _ _ _ _ _ account _ secret; [[ -n "${FAKE_LOCKED:-}" ]] && exit 36; printf '%s\n' "$secret" > "$CHAIN/entry-$account" ;;
  find-generic-password)
    [[ -n "${FAKE_LOCKED:-}" ]] && exit 36
    f="$(entry "$@")"; [[ -f "$f" ]] || exit 44
    [[ " $* " == *" -w "* ]] && cat "$f"; exit 0 ;;
  delete-generic-password) f="$(entry "$@")"; [[ -f "$f" ]] || exit 44; rm "$f" ;;
esac
FAKE
chmod +x "$WORK/bin/security"; export CHAIN="$WORK/chain" PATH="$WORK/bin:$PATH"
printf '%s\n' "$TOKEN" | "$CCA" token 2 >/dev/null
"$CCA" 2 -p x
check "the Keychain store gives the account its token" "token=$TOKEN" "$(login)"
check "and the token is never an argument of the command that keeps it" "0" "$(grep -c "$TOKEN" "$CHAIN/argv")"
: > "$LOG.login"; err="$(FAKE_LOCKED=1 "$CCA" 2 -p x 2>&1 >/dev/null)"
check "a store that cannot be read is reported and the session runs on the account's /login" \
  "token=unset cca: the token kept for 2 could not be read (security: 36); running on its /login" "$(login) $err"
"$CCA" token 2 --remove >/dev/null
: > "$LOG.login"; "$CCA" 2 -p x
check "the Keychain store forgets a removed token" "token=unset" "$(login)"

finish
