#!/usr/bin/env bash
set -euo pipefail

command="${1:-install}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="${DIFFUSE_INSTALL_ROOT:-$HOME/.local/share/diffuse}"
bin_dir="${DIFFUSE_BIN_DIR:-$HOME/.local/bin}"
bin_path="$bin_dir/diffuse"

install_diffuse() {
  "$root/scripts/requirements.sh" install
  require_file "$root/core/zig-out/bin/diffuse"
  require_file "$root/app/out/main/main.js"
  require_file "$root/app/out/renderer/index.html"
  require_dir "$root/app/node_modules/electron"

  mkdir -p "$install_root/app" "$install_root/core" "$bin_dir"
  rm -rf "$install_root/app/out" "$install_root/app/node_modules" "$install_root/core/diffuse"
  cp -R "$root/app/out" "$install_root/app/out"
  cp -R "$root/app/node_modules" "$install_root/app/node_modules"
  cp "$root/app/package.json" "$install_root/app/package.json"
  cp "$root/core/zig-out/bin/diffuse" "$install_root/core/diffuse"
  cp "$root/core/zig-out/bin/diffuse" "$bin_path"
  chmod 755 "$install_root/core/diffuse" "$bin_path"

  write_metadata
  ensure_path
  install_desktop_file
  install_completions
  echo "Installed Diffuse to $install_root"
  echo "Command: $bin_path"
}

uninstall_diffuse() {
  rm -rf "$install_root" "$bin_path"
  rm -f "$HOME/.local/share/applications/diffuse.desktop"
  rm -f "$HOME/.local/share/bash-completion/completions/diffuse"
  rm -f "$HOME/.zfunc/_diffuse"
  rm -f "$HOME/.config/fish/completions/diffuse.fish"
  echo "Uninstalled Diffuse"
}

install_completions() {
  mkdir -p "$HOME/.local/share/bash-completion/completions" "$HOME/.zfunc" "$HOME/.config/fish/completions"
  "$root/core/zig-out/bin/diffuse" completion bash > "$HOME/.local/share/bash-completion/completions/diffuse"
  "$root/core/zig-out/bin/diffuse" completion zsh > "$HOME/.zfunc/_diffuse"
  "$root/core/zig-out/bin/diffuse" completion fish > "$HOME/.config/fish/completions/diffuse.fish"
  echo "Installed shell completions for bash, zsh, and fish"
  ensure_zsh_fpath
}

ensure_path() {
  case ":$PATH:" in
    *":$bin_dir:"*) return 0 ;;
  esac

  append_once "$HOME/.profile" "export PATH=\"$bin_dir:\$PATH\""
  if [[ -n "${BASH_VERSION:-}" || -f "$HOME/.bashrc" ]]; then
    append_once "$HOME/.bashrc" "export PATH=\"$bin_dir:\$PATH\""
  fi
  if [[ -n "${ZSH_VERSION:-}" || -f "$HOME/.zshrc" ]]; then
    append_once "$HOME/.zshrc" "export PATH=\"$bin_dir:\$PATH\""
  fi
  if [[ -d "$HOME/.config/fish" ]]; then
    append_once "$HOME/.config/fish/config.fish" "fish_add_path $bin_dir"
  fi
  echo "Added $bin_dir to user PATH configuration. Restart your shell or source your profile to use diffuse immediately."
}

ensure_zsh_fpath() {
  append_once "$HOME/.zshrc" 'fpath=(~/.zfunc $fpath)'
  echo "Configured zsh completion path in ~/.zshrc. Run compinit after restarting zsh if needed."
}

append_once() {
  file="$1"
  line="$2"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  grep -Fqx "$line" "$file" || printf '\n%s\n' "$line" >> "$file"
}

install_desktop_file() {
  [[ "$(uname -s)" == "Linux" ]] || return 0
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/diffuse.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Diffuse
Comment=Review and inspect repository diffs
Exec=$bin_path %F
Terminal=false
Categories=Development;RevisionControl;
StartupNotify=true
EOF
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
  fi
}

write_metadata() {
  version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$root/app/package.json" | head -n 1)"
  commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || true)"
  tag="$(git -C "$root" describe --tags --exact-match 2>/dev/null || true)"
  cat > "$install_root/metadata.json" <<EOF
{
  "version": "$version",
  "source": "source",
  "tag": ${tag:+"$tag"}${tag:-null},
  "commit": ${commit:+"$commit"}${commit:-null}
}
EOF
}

require_file() {
  [[ -f "$1" ]] || { echo "Missing build artifact: $1. Run just build first." >&2; exit 1; }
}

require_dir() {
  [[ -d "$1" ]] || { echo "Missing build artifact: $1. Run just build first." >&2; exit 1; }
}

case "$command" in
  install) install_diffuse ;;
  uninstall) uninstall_diffuse ;;
  completions) install_completions ;;
  *) echo "Unknown install command: $command" >&2; exit 2 ;;
esac
