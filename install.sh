#!/usr/bin/env bash
# Installs cc-accounts, then sets it up for your current Claude Code account.
#
#   curl -fsSL https://raw.githubusercontent.com/wazeemlabs/cc-accounts/main/install.sh | bash -s -- <name>
#   ./install.sh <name>            from a clone, which stays where it is
#
# <name> is what you call the account you are signed in to now (say, "work").
# Without it, cc-accounts is installed and `cca init <name>` is left to you.
#
# CCA_HOME   where to clone (default ~/.local/share/cc-accounts)
# CCA_REF    the tag or branch to install (default main)
# CCA_REPO   the repository to clone (default this one; for forks and tests)
set -euo pipefail

REPO="${CCA_REPO:-https://github.com/wazeemlabs/cc-accounts.git}"
DEST="${CCA_HOME:-$HOME/.local/share/cc-accounts}"
REF="${CCA_REF:-main}"

fail() { echo "cc-accounts: $*" >&2; exit 1; }

command -v git >/dev/null || fail "needs git"
command -v python3 >/dev/null || fail "needs python3 (3.8 or newer)"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || fail "needs python3 3.8 or newer"
case "$(uname)" in
  Darwin|Linux) ;;
  *) fail "runs on macOS and Linux (and WSL)" ;;
esac
command -v claude >/dev/null || [[ -x "$HOME/.local/bin/claude" ]] \
  || echo "cc-accounts: Claude Code is not installed yet; install it before using cca" >&2

# Run from a clone: use it in place. Piped from curl: clone or update DEST.
here=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fi
if [[ -n "$here" && -x "$here/bin/cca" ]]; then
  DEST="$here"
elif [[ -d "$DEST/.git" ]]; then
  git -C "$DEST" fetch --quiet --tags origin
else
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet "$REPO" "$DEST"
fi
if [[ "$DEST" != "$here" ]]; then
  if git -C "$DEST" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    git -C "$DEST" checkout --quiet "$REF"
    git -C "$DEST" merge --quiet --ff-only "origin/$REF"
  else
    git -C "$DEST" -c advice.detachedHead=false checkout --quiet "refs/tags/$REF"
  fi
fi
echo "cc-accounts $(cat "$DEST/VERSION") is in $DEST"

if [[ $# -gt 0 ]]; then
  exec "$DEST/bin/cca" init "$@"
fi
echo "Next: $DEST/bin/cca init <name>, naming the account you are signed in to now."
