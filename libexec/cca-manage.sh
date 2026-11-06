# shellcheck shell=bash
# cca's account set-up, sourced by bin/cca: init (adopting ~/.claude's
# conversations into the shared folder), linking an account to what every
# account shares, and remove. It uses bin/cca's settings and helpers (die,
# dir_of, valid_name, default_name and the paths), which are defined by the
# time a command runs.

# bin/cca sets these before it sources this file.
: "${ROOT:?}" "${TABLE:?}" "${SHARED:?}" "${HOME_DIR:?}"

# What every other account links from ~/.claude: share.conf, one name a line.
share_list() {
  if [[ -f "$ROOT/share.conf" ]]; then
    grep -v '^[[:space:]]*\(#\|$\)' "$ROOT/share.conf" || true
  else
    printf '%s\n' "${DEFAULT_SHARE[@]}"
  fi
}

# Links one item of an account to its shared copy, keeping what was there.
link_item() {
  local path="$1" target="$2" stamp
  [[ -L "$path" && "$(readlink "$path")" == "$target" ]] && return 0
  if [[ -e "$path" || -L "$path" ]]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    mv "$path" "$path.bak-$stamp"
    echo "cca: kept the old $path as $(basename "$path").bak-$stamp" >&2
  fi
  ln -s "$target" "$path"
}

link_shared() {
  local dir="$1" item
  for item in "${SHARED_STATE[@]}"; do
    mkdir -p "$SHARED/$item"
    link_item "$dir/$item" "$SHARED/$item"
  done
  [[ "$dir" == "$HOME_DIR" ]] && return 0
  while IFS= read -r item; do
    [[ -e "$HOME_DIR/$item" ]] && link_item "$dir/$item" "$HOME_DIR/$item"
  done < <(share_list)
  return 0
}

# Moves ~/.claude's own conversations and sessions into the shared dir and
# links them back, so the accounts added later see them.
adopt_home() {
  local item
  mkdir -p "$SHARED"
  for item in "${SHARED_STATE[@]}"; do
    local own="$HOME_DIR/$item" shared="$SHARED/$item"
    if [[ -L "$own" ]]; then
      [[ "$(readlink "$own")" == "$shared" ]] || die "$own links to $(readlink "$own"), not $shared; move it by hand"
      continue
    fi
    if [[ -d "$own" ]]; then
      if [[ -d "$shared" ]]; then
        [[ -z "$(ls -A "$shared")" ]] || die "both $own and $shared hold files; merge them by hand, then run init again"
        rmdir "$shared"  # empty: mv needs the name free
      fi
      mv "$own" "$shared"
    else
      mkdir -p "$shared"
    fi
    ln -s "$shared" "$own"
  done
}

# Live Claude Code sessions, from Claude Code's own session list.
running_sessions() {
  "$LIBEXEC/cca-setup" running "$HOME_DIR/sessions"
}

# The rc file of the person's shell, or nothing for a shell cca does not know.
shell_rc() {
  case "$(basename "${SHELL:-}")" in
    zsh) echo "$HOME/.zshrc" ;;
    bash) echo "$HOME/.bashrc" ;;
    fish) echo "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
  esac
  return 0
}

init() {
  local name="$1" yes="$2" rc; rc="$(shell_rc)"
  valid_name "$name"
  if [[ -n "$(dir_of "$name")" && "$(dir_of "$name")" != "$HOME_DIR" ]]; then
    die "'$name' is already $(dir_of "$name")"
  fi
  local home_name=""
  if [[ -f "$TABLE" ]]; then
    home_name="$(awk -F'\t' -v d="$HOME_DIR" '$2 == d { print $1 }' "$TABLE")"
  fi
  [[ -z "$home_name" || "$home_name" == "$name" ]] || die "$HOME_DIR is already the account '$home_name'"
  # Moving ~/.claude's folders under a running session is what needs it quit;
  # a second init, with them already moved, does not.
  local item to_move=no
  for item in "${SHARED_STATE[@]}"; do
    [[ -d "$HOME_DIR/$item" && ! -L "$HOME_DIR/$item" ]] && to_move=yes
  done
  if [[ "$to_move" == yes && -n "$(running_sessions)" && "$yes" != yes ]]; then
    die "Claude Code is running (pids: $(running_sessions | paste -sd' ' -)). Quit it first, or run cca init $name --yes"
  fi
  "$LIBEXEC/cca-setup" check --settings "$HOME_DIR/settings.json"
  mkdir -p "$HOME_DIR" "$ROOT"
  adopt_home
  [[ -n "$(dir_of "$name")" ]] || printf '%s\t%s\n' "$name" "$HOME_DIR" >> "$TABLE"
  [[ -s "$ROOT/default" ]] || printf '%s\n' "$name" > "$ROOT/default"
  if [[ ! -f "$ROOT/share.conf" ]]; then
    {
      echo "# Linked from ~/.claude into every other account, one name a line."
      echo "# Run cca add <name> again for an account after changing this."
      printf '%s\n' "${DEFAULT_SHARE[@]}"
    } > "$ROOT/share.conf"
  fi
  "$LIBEXEC/cca-setup" install \
    --rc "$rc" --shell "$(basename "${SHELL:-}")" --bin "$HERE/bin" \
    --settings "$HOME_DIR/settings.json" --plugin "$PLUGIN" \
    --wrapper "$HERE/bin/cca"
  echo "Account $name is $HOME_DIR. Add the others with: cca add <name>"
  [[ -n "$rc" ]] && echo "Open a new terminal to start using it. In an editor, reload the window."
  return 0
}

# Takes <name> out of the table, so no session starts or moves there, and
# drops what cca and the plugin kept of it. Its folder and login stay, so
# `cca add <name> <dir>` brings it back. A conversation it last ran opens on
# the default account next time. ~/.claude holds what every account links,
# and the default must stay an account, so neither is removed.
remove_account() {
  local name="$1" dir
  require_account "$name"
  dir="$(dir_of "$name")"
  [[ "$dir" != "$HOME_DIR" ]] || die "$name is $HOME_DIR, which every account links its settings from; it cannot be removed"
  [[ "$(default_name)" != "$name" ]] || die "new sessions start on $name; run cca use <another account> first"
  local tmp; tmp="$(mktemp "$TABLE.XXXXXX")"
  awk -F'\t' -v n="$name" '$1 != n' "$TABLE" > "$tmp" && mv "$tmp" "$TABLE"
  rm -f "$ROOT/usage/$name.json"
  rm -rf "${ROOT:?}/blocked/$name"
  echo "Removed $name. Its folder $dir is left as it is: cca add $name $dir brings it back."
}
