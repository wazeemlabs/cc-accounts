# shellcheck shell=bash
# An account's long-lived token (claude setup-token), sourced by bin/cca. A
# /login ends after a time and cannot renew itself where nobody is there to
# sign in again; a token lasts a year. Claude Code uses a token in
# CLAUDE_CODE_OAUTH_TOKEN over the account's own login, and such a session can
# only make model requests: no Artifacts, Remote Control, claude.ai connectors
# or Chrome tools. So a token is kept only for the accounts a person names.
#
# The token lives in the machine's secret store: the macOS Keychain, else a
# file only its owner can read (where Claude Code keeps its own login on
# Linux). CCA_TOKEN_STORE=keychain|file picks one.

: "${ROOT:?}"
TOKEN_SERVICE=cc-accounts
# What claude setup-token prints: no space or quote, so it can be handed to
# `security -i` as one word.
TOKEN_RE='^sk-ant-oat[0-9]+-[A-Za-z0-9_-]{16,}$'

token_store() {
  if [[ -n "${CCA_TOKEN_STORE:-}" ]]; then echo "$CCA_TOKEN_STORE"; return; fi
  if [[ "$(uname)" == Darwin ]] && command -v security >/dev/null; then echo keychain; else echo file; fi
}

# Prints the account's token, or nothing when it has none. A store that
# holds one and cannot be read is reported: the session then runs on the
# account's /login, and the person should know why.
token_of() {
  local name="$1" token status=0
  case "$(token_store)" in
    keychain)
      token="$(security find-generic-password -s "$TOKEN_SERVICE" -a "$name" -w 2>/dev/null)" || status=$?
      # 44: no such entry.
      if [[ $status -ne 0 && $status -ne 44 ]]; then
        echo "cca: the token kept for $name could not be read (security: $status); running on its /login" >&2
        return 0
      fi
      ;;
    file) [[ -f "$ROOT/tokens/$name" ]] && token="$(cat "$ROOT/tokens/$name")" ;;
    *) die "CCA_TOKEN_STORE is keychain or file, not '$(token_store)'" ;;
  esac
  printf '%s' "${token:-}"
}

# Keeps the token for the account. It reaches the Keychain on stdin: an
# argument would show in the process list.
keep_token() {
  local name="$1" token="$2"
  case "$(token_store)" in
    keychain)
      printf 'add-generic-password -U -s %s -a %s -w %s\n' "$TOKEN_SERVICE" "$name" "$token" \
        | security -i >/dev/null || die "the Keychain did not take the token"
      ;;
    file)
      (umask 077; mkdir -p "$ROOT/tokens"; chmod 700 "$ROOT/tokens"; printf '%s\n' "$token" > "$ROOT/tokens/$name")
      ;;
    *) die "CCA_TOKEN_STORE is keychain or file, not '$(token_store)'" ;;
  esac
}

# Forgets the account's token; fails when it has none.
drop_token() {
  local name="$1"
  case "$(token_store)" in
    keychain) security delete-generic-password -s "$TOKEN_SERVICE" -a "$name" >/dev/null 2>&1 ;;
    file) [[ -f "$ROOT/tokens/$name" ]] && rm -f "$ROOT/tokens/$name" ;;
    *) die "CCA_TOKEN_STORE is keychain or file, not '$(token_store)'" ;;
  esac
}

# cca token <name> [--remove]
token_command() {
  local usage="usage: cca token <name> [--remove]"
  [[ $# -ge 1 && $# -le 2 ]] || die "$usage"
  local name="$1" token
  require_account "$name"
  if [[ $# -eq 2 ]]; then
    [[ "$2" == --remove ]] || die "$usage"
    drop_token "$name" || die "$name has no token"
    echo "Account $name runs on its /login again."
    return 0
  fi
  if [[ -t 0 ]]; then
    read -rs -p "Paste the token claude setup-token printed for $name (it is not shown): " token; echo
  else
    IFS= read -r token || true
  fi
  token="${token//[[:space:]]/}"
  [[ "$token" =~ $TOKEN_RE ]] || die "that is not a token from claude setup-token (it starts sk-ant-oat)"
  keep_token "$name" "$token"
  echo "Account $name now runs on its long-lived token, not its /login."
  echo "Sessions on it can only make model requests: no Artifacts, Remote Control, claude.ai connectors or Chrome tools."
  echo "Sessions already open keep their login until they restart. Undo with: cca token $name --remove"
}
