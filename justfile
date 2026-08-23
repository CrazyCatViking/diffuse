set shell := ["sh", "-cu"]
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

[unix]
build:
    ./scripts/requirements.sh build
    node scripts/check-rpc-contract.mjs
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo test --workspace --all-targets --locked
    cargo build --workspace --locked
    (cd core && zig build test)
    (cd core && zig build)
    (cd app && pnpm install --frozen-lockfile)
    (cd app && pnpm test:rust-integration)
    (cd app && pnpm build)

[windows]
build:
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Missing required command: git' }
    if (-not (Get-Command just -ErrorAction SilentlyContinue)) { throw 'Missing required command: just' }
    if (-not (Get-Command zig -ErrorAction SilentlyContinue)) { throw 'Missing required command: zig' }
    if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) { throw 'Missing required command: rustup' }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Missing required command: cargo' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Missing required command: node' }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'Missing required command: pnpm' }
    node scripts/check-rpc-contract.mjs
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo test --workspace --all-targets --locked
    cargo build --workspace --locked
    Push-Location core; zig build test; zig build; Pop-Location
    Push-Location app; pnpm install --frozen-lockfile; pnpm test:rust-integration; pnpm build; Pop-Location

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
apparmor:
    ./scripts/apparmor.sh install \
      "$HOME/.local/share/diffuse/app/node_modules/.pnpm/electron@*/node_modules/electron/dist/electron" \
      "$(pwd)/app/node_modules/.pnpm/electron@*/node_modules/electron/dist/electron"

[unix]
apparmor-status:
    ./scripts/apparmor.sh status

[unix]
install-completions:
    ./scripts/install.sh completions

[windows]
install-completions:
    ./scripts/install.ps1 completions

[unix]
update: build
    core/zig-out/bin/diffuse update

[windows]
update: build
    core/zig-out/bin/diffuse.exe update

[unix]
install-version version:
    core/zig-out/bin/diffuse install {{version}}

[windows]
install-version version:
    core/zig-out/bin/diffuse.exe install {{version}}

[unix]
completion shell:
    core/zig-out/bin/diffuse completion {{shell}}

[windows]
completion shell:
    core/zig-out/bin/diffuse.exe completion {{shell}}

[unix]
list-versions *args:
    core/zig-out/bin/diffuse list-versions {{args}}

[windows]
list-versions *args:
    core/zig-out/bin/diffuse.exe list-versions {{args}}

[unix]
publish version="":
    ./scripts/publish.sh {{version}}

[unix]
publish-dry-run version="":
    ./scripts/publish.sh --dry-run {{version}}
