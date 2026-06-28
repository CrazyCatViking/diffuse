#!/usr/bin/env sh
set -eu

repo="${DIFFUSE_GITHUB_REPO:-CrazyCatViking/diffuse}"
version="${DIFFUSE_VERSION:-latest}"
install_root="${DIFFUSE_INSTALL_ROOT:-$HOME/.local/share/diffuse}"
bin_dir="${DIFFUSE_BIN_DIR:-$HOME/.local/bin}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need curl
need tar

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

case "$os" in
  linux) asset_os="linux"; asset_ext="tar.gz" ;;
  darwin) asset_os="mac"; asset_ext="zip"; need unzip ;;
  *) echo "Unsupported platform: $os" >&2; exit 1 ;;
esac

if [ "$version" = "latest" ]; then
  version="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
fi

if [ -z "$version" ]; then
  echo "Could not resolve Diffuse release version." >&2
  exit 1
fi

tag="$version"
plain_version="${version#v}"
asset="diffuse-$plain_version-$asset_os-$arch.$asset_ext"
url="https://github.com/$repo/releases/download/$tag/$asset"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $url"
curl -fL "$url" -o "$tmp/$asset"

mkdir -p "$install_root" "$bin_dir"

if [ "$asset_os" = "linux" ]; then
  mkdir -p "$tmp/app"
  tar -xzf "$tmp/$asset" -C "$tmp/app"
  app_dir="$(find "$tmp/app" -maxdepth 2 -type f \( -name Diffuse -o -name diffuse \) -perm -111 -print | head -n 1)"
  if [ -z "$app_dir" ]; then
    echo "Could not find Diffuse executable in $asset" >&2
    exit 1
  fi
  app_dir="$(dirname "$app_dir")"
  rm -rf "$install_root/app"
  cp -R "$app_dir" "$install_root/app"
  app="$install_root/app/$(basename "$(find "$install_root/app" -maxdepth 1 -type f \( -name Diffuse -o -name diffuse \) -perm -111 -print | head -n 1)")"
  core="$install_root/app/resources/diffuse"
  cat > "$bin_dir/diffuse" <<EOF
#!/usr/bin/env sh
app="$app"
core="$core"
launch_app() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "\$app" "\$@" >/dev/null 2>&1 &
  else
    nohup "\$app" "\$@" >/dev/null 2>&1 &
  fi
}
resolve_repository_path() {
  if [ -d "\$1" ]; then
    cd "\$1" && pwd -P
  else
    printf '%s\n' "\$1"
  fi
}
if [ "\$#" -eq 0 ]; then
  launch_app
  exit 0
fi
case "\$1" in
  update)
    exec sh -c "\$(curl -fsSL https://raw.githubusercontent.com/$repo/main/scripts/install-release.sh)"
    ;;
  install)
    if [ "\$#" -lt 2 ]; then echo "Usage: diffuse install <version>" >&2; exit 2; fi
    DIFFUSE_VERSION="\$2" exec sh -c "\$(curl -fsSL https://raw.githubusercontent.com/$repo/main/scripts/install-release.sh)"
    ;;
  --help|--version|version|completion|list-versions|rpc|files|diff)
    exec "\$core" "\$@"
    ;;
  *)
    repo_path="\$(resolve_repository_path "\$1")"
    launch_app --open-repository "\$repo_path"
    exit 0
    ;;
esac
EOF
  chmod 755 "$bin_dir/diffuse"
  applications_dir="$HOME/.local/share/applications"
  mkdir -p "$applications_dir"
  cat > "$applications_dir/diffuse.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Diffuse
Comment=Review and inspect repository diffs
Exec=$bin_dir/diffuse %F
Terminal=false
Categories=Development;RevisionControl;
StartupNotify=true
EOF
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
  fi
else
  apps_dir="${DIFFUSE_APPLICATIONS_DIR:-$HOME/Applications}"
  mkdir -p "$apps_dir"
  mkdir -p "$tmp/app"
  unzip -q "$tmp/$asset" -d "$tmp/app"
  app_source="$(find "$tmp/app" -maxdepth 3 -type d -iname Diffuse.app -print | head -n 1)"
  if [ -z "$app_source" ]; then
    echo "Could not find Diffuse.app in $asset" >&2
    exit 1
  fi
  rm -rf "$apps_dir/Diffuse.app"
  cp -R "$app_source" "$apps_dir/Diffuse.app"
  cat > "$bin_dir/diffuse" <<EOF
#!/usr/bin/env sh
app="$apps_dir/Diffuse.app"
core="$apps_dir/Diffuse.app/Contents/Resources/diffuse"
if [ "\$#" -eq 0 ]; then
  open -a "\$app" >/dev/null 2>&1 &
  exit 0
fi
resolve_repository_path() {
  if [ -d "\$1" ]; then
    cd "\$1" && pwd -P
  else
    printf '%s\n' "\$1"
  fi
}
case "\$1" in
  update)
    exec sh -c "\$(curl -fsSL https://raw.githubusercontent.com/$repo/main/scripts/install-release.sh)"
    ;;
  install)
    if [ "\$#" -lt 2 ]; then echo "Usage: diffuse install <version>" >&2; exit 2; fi
    DIFFUSE_VERSION="\$2" exec sh -c "\$(curl -fsSL https://raw.githubusercontent.com/$repo/main/scripts/install-release.sh)"
    ;;
  --help|--version|version|completion|list-versions|rpc|files|diff)
    exec "\$core" "\$@"
    ;;
  *)
    repo_path="\$(resolve_repository_path "\$1")"
    open -a "\$app" --args --open-repository "\$repo_path" >/dev/null 2>&1 &
    exit 0
    ;;
esac
EOF
  chmod 755 "$bin_dir/diffuse"
fi

cat > "$install_root/metadata.json" <<EOF
{
  "version": "$plain_version",
  "source": "github-release",
  "tag": "$tag"
}
EOF

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH to run diffuse from a new shell." ;;
esac

echo "Installed Diffuse $tag"
echo "Command: $bin_dir/diffuse"
