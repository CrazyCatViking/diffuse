#!/usr/bin/env bash
set -euo pipefail

dry_run=0
version=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    *) version="$arg" ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

"$root/scripts/requirements.sh" publish

status="$(git status --porcelain)"
if [[ -n "$status" && "$dry_run" -eq 0 ]]; then
  echo "Working tree must be clean before publishing. Commit or stash these changes first:" >&2
  echo "$status" >&2
  exit 1
fi
if [[ -n "$status" && "$dry_run" -eq 1 ]]; then
  echo "Dry run: working tree is dirty; real publish would stop before making changes."
fi

current="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' app/package.json | head -n 1)"
if [[ -z "$version" ]]; then
  IFS=. read -r major minor patch <<< "$current"
  version="$major.$minor.$((patch + 1))"
fi
version="${version#v}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must use MAJOR.MINOR.PATCH format, got: $version" >&2
  exit 1
fi
tag="v$version"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Tag already exists locally: $tag" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
  echo "Tag already exists on origin: $tag" >&2
  exit 1
fi

if [[ "$dry_run" -eq 1 ]]; then
  echo "Would publish Diffuse $version"
  echo "Would update app/package.json and core/src/protocol/types.zig"
  echo "Would commit: Release $tag"
  echo "Would tag: $tag"
  echo "Would push commit and tag to origin"
  echo "GitHub Actions would build artifacts and create the GitHub Release"
  exit 0
fi

sed -i.bak -E 's/("version": ")[^"]*(")/\1'"$version"'\2/' app/package.json && rm app/package.json.bak
sed -i.bak -E 's/pub const version = "[^"]*";/pub const version = "'"$version"'";/' core/src/protocol/types.zig && rm core/src/protocol/types.zig.bak
git add app/package.json core/src/protocol/types.zig
git commit -m "Release $tag"
git tag "$tag"
git push origin HEAD
git push origin "$tag"
echo "Published $tag"
echo "GitHub Actions will build release artifacts and create the GitHub Release."
