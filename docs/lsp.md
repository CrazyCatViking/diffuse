# LSP Support

Diffuse uses language servers for hover information and diagnostics in diffs.

## Configuration

User LSP configuration lives at `~/.diffuse/lsp.json`.

Each server entry can override the built-in command and args:

```json
{
  "servers": {
    "zig": {
      "command": "/home/user/.local/share/nvim/mason/bin/zls",
      "args": []
    }
  }
}
```

## Built-In Servers

Diffuse has built-in defaults for:

- TypeScript and JavaScript: `typescript-language-server --stdio`
- Rust: `rust-analyzer`
- Python: `pyright-langserver --stdio`
- Go: `gopls`
- Zig: `zls`
- Lua: `lua-language-server`

## Diagnostics

Diagnostics are shown only for the new side of a diff. Old-side hover is supported, but old-side diagnostics are intentionally not shown because diagnostics should describe the code that will exist after the change.

Diffuse supports both LSP publish diagnostics and pull diagnostics. Pull diagnostics are only requested if the server advertises `diagnosticProvider`.

## Mason

If you install servers with Mason, set the command path in `~/.diffuse/lsp.json` when the server binary is not on `PATH`.

Common Mason binary paths:

- `~/.local/share/nvim/mason/bin/zls`
- `~/.local/share/nvim/mason/bin/lua-language-server`
- `~/.local/share/nvim/mason/bin/pyright-langserver`

## Install Actions

Settings > Language Servers shows install guidance for missing servers.

Diffuse currently runs only curated non-shell installers marked safe by core:

- `rustup component add rust-analyzer`
- `go install golang.org/x/tools/gopls@latest`

Other installers remain copy-only for now, including global npm installs and manual/Mason installs.

## Server Lifecycle

Language servers are persistent per repository/language/server. Settings shows whether a session is running and exposes a restart action for running or errored sessions.
