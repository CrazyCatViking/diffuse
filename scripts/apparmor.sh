#!/usr/bin/env sh
# Install an AppArmor profile granting Diffuse permission to create
# unprivileged user namespaces.
#
# Ubuntu 24.04+ sets kernel.apparmor_restrict_unprivileged_userns=1, which stops
# unconfined binaries from creating unprivileged user namespaces. Electron needs
# them for its namespace sandbox; without them it falls back to the SUID helper
# (chrome-sandbox), which must be root-owned and mode 4755 -- something a
# user-local install can never set up. Granting userns here is the supported fix
# and keeps the sandbox enabled.
#
# Usage:
#   apparmor.sh install <app-binary> [dev-electron-glob]
#   apparmor.sh uninstall
#   apparmor.sh status
set -eu

profile_path="/etc/apparmor.d/diffuse"

needs_profile() {
  [ "$(uname -s)" = "Linux" ] || return 1
  [ -d /etc/apparmor.d ] || return 1
  command -v apparmor_parser >/dev/null 2>&1 || return 1
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]
}

render_profile() {
  app="$1"
  dev_glob="${2:-}"
  cat <<EOF
# Managed by Diffuse (scripts/apparmor.sh). Regenerated on install.
#
# Grants only the userns permission needed for Electron's namespace sandbox.
# The binaries stay otherwise unconfined, matching /etc/apparmor.d/chrome.

abi <abi/4.0>,
include <tunables/global>

profile diffuse "$app" flags=(unconfined) {
  userns,
  @{exec_path} mr,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/diffuse>
}
EOF

  [ -n "$dev_glob" ] || return 0
  cat <<EOF

# Development build: Electron launched from this source checkout by \`pnpm dev\`.
profile diffuse-dev "$dev_glob" flags=(unconfined) {
  userns,
  @{exec_path} mr,

  include if exists <local/diffuse-dev>
}
EOF
}

install_profile() {
  app="${1:-}"
  dev_glob="${2:-}"
  if [ -z "$app" ]; then
    echo "Usage: apparmor.sh install <app-binary> [dev-electron-glob]" >&2
    exit 2
  fi

  if ! needs_profile; then
    echo "AppArmor userns restriction not active; skipping AppArmor profile."
    return 0
  fi

  tmp_profile="$(mktemp)"
  trap 'rm -f "$tmp_profile"' EXIT INT TERM
  render_profile "$app" "$dev_glob" > "$tmp_profile"

  if ! apparmor_parser -Q --skip-cache "$tmp_profile" 2>/dev/null; then
    echo "Generated AppArmor profile failed to parse; skipping." >&2
    return 0
  fi

  if [ -r "$profile_path" ] && cmp -s "$tmp_profile" "$profile_path"; then
    echo "AppArmor profile already up to date at $profile_path"
    return 0
  fi

  if [ "$(id -u)" = "0" ]; then
    apply_profile "$tmp_profile"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    apply_profile "$tmp_profile" sudo
  else
    staged="${XDG_CACHE_HOME:-$HOME/.cache}/diffuse/apparmor-diffuse"
    mkdir -p "$(dirname "$staged")"
    cp "$tmp_profile" "$staged"
    cat >&2 <<EOF

Diffuse needs an AppArmor profile to run its Electron sandbox on this system.
Root is required once. Run:

  sudo install -m 644 "$staged" $profile_path && sudo apparmor_parser -r $profile_path

Until then Diffuse will fail to start with a chrome-sandbox error.
EOF
    return 0
  fi
}

apply_profile() {
  src="$1"
  sudo_cmd="${2:-}"
  $sudo_cmd install -m 644 "$src" "$profile_path"
  $sudo_cmd apparmor_parser -r "$profile_path"
  echo "Installed AppArmor profile at $profile_path"
}

uninstall_profile() {
  [ -e "$profile_path" ] || return 0
  sudo_cmd=""
  if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo_cmd="sudo"
    else
      echo "Leaving $profile_path in place; remove it with:" >&2
      echo "  sudo apparmor_parser -R $profile_path && sudo rm $profile_path" >&2
      return 0
    fi
  fi
  $sudo_cmd apparmor_parser -R "$profile_path" 2>/dev/null || true
  $sudo_cmd rm -f "$profile_path"
  echo "Removed AppArmor profile"
}

status_profile() {
  if needs_profile; then
    echo "AppArmor userns restriction: active (profile required)"
  else
    echo "AppArmor userns restriction: not active (profile not needed)"
  fi
  if [ -e "$profile_path" ]; then
    echo "Profile installed: $profile_path"
  else
    echo "Profile installed: no"
  fi
}

case "${1:-status}" in
  install) shift; install_profile "$@" ;;
  uninstall) uninstall_profile ;;
  status) status_profile ;;
  *) echo "Unknown apparmor command: ${1:-}" >&2; exit 2 ;;
esac
