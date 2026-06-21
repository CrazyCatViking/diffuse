set shell := ["sh", "-cu"]
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

[unix]
build:
    ./scripts/requirements.sh build
    (cd core && zig build)
    (cd app && pnpm install --frozen-lockfile)
    (cd app && pnpm build)

[windows]
build:
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Missing required command: git' }
    if (-not (Get-Command just -ErrorAction SilentlyContinue)) { throw 'Missing required command: just' }
    if (-not (Get-Command zig -ErrorAction SilentlyContinue)) { throw 'Missing required command: zig' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Missing required command: node' }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'Missing required command: pnpm' }
    Push-Location core; zig build; Pop-Location
    Push-Location app; pnpm install --frozen-lockfile; pnpm build; Pop-Location

[unix]
install: build
    ./scripts/install.sh install

[windows]
install: build
    ./scripts/install.ps1 install

[unix]
uninstall:
    ./scripts/install.sh uninstall

[windows]
uninstall:
    ./scripts/install.ps1 uninstall

[unix]
install-completions:
    ./scripts/install.sh completions

[windows]
install-completions:
    ./scripts/install.ps1 completions

update: build
    core/zig-out/bin/diffuse update

install-version version:
    core/zig-out/bin/diffuse install {{version}}

completion shell:
    core/zig-out/bin/diffuse completion {{shell}}

list-versions *args:
    core/zig-out/bin/diffuse list-versions {{args}}

[unix]
publish version="":
    ./scripts/publish.sh {{version}}

[windows]
publish version="":
    ./scripts/publish.ps1 {{version}}

[unix]
publish-dry-run version="":
    ./scripts/publish.sh --dry-run {{version}}

[windows]
publish-dry-run version="":
    ./scripts/publish.ps1 -DryRun {{version}}
