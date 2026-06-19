# LSP Support

Diffuse uses language servers for hover information and diagnostics in diffs.

## Configuration

User LSP configuration lives at `~/.diffuse/lsp.json`.

Each server entry can override a built-in command or add a server command you installed yourself:

```json
{
  "servers": {
    "zig": {
      "command": "/home/user/bin/zls",
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

## Manual Servers

If you install a server outside Diffuse and the binary is not on `PATH`, set the full command path in `~/.diffuse/lsp.json`.

Example:

```json
{
  "servers": {
    "lua": {
      "command": "/opt/lua-language-server/bin/lua-language-server",
      "args": []
    }
  }
}
```

## Install Actions

Settings > Language Servers shows install guidance for missing servers.

Diffuse currently runs only curated non-shell installers marked safe by core:

- `rustup component add rust-analyzer`
- `go install golang.org/x/tools/gopls@latest`

Other installers remain copy-only for now, including global npm installs and manual installs.

## Server Lifecycle

Language servers are persistent per repository/language/server. Settings shows whether a session is running and exposes a restart action for running or errored sessions.
