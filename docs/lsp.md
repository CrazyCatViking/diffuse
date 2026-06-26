# LSP Support

Diffuse uses language servers for hover information and diagnostics in diffs.

## Configuration

User LSP configuration lives at `~/.diffuse/lsp.json`.

Each server entry can override a built-in command or add a server command you installed yourself. The top-level key is `lsp`:

```json
{
  "lsp": {
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

The review overview derives its session-wide diagnostic counts by requesting new-side diagnostics for supported changed files while the overview is active. These counts are not persisted in review state.

Hover and diagnostics use the same source side as the active diff target:

- Branch/ref comparisons read old-side source from the target ref and new-side source from the source ref.
- Staged-only comparisons read old-side source from the base ref and new-side source from the Git index.
- Unstaged-only comparisons read old-side source from the Git index and new-side source from the working tree.
- Working-tree comparisons read old-side source from the base ref and new-side source from the working tree.

## Manual Servers

If you install a server outside Diffuse and the binary is not on `PATH`, set the full command path in `~/.diffuse/lsp.json`.

Example:

```json
{
  "lsp": {
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

Settings can open `~/.diffuse/lsp.json`. If the file does not exist, Diffuse creates a starter file:

```json
{
  "lsp": {
    "zig": {
      "command": "zls",
      "args": []
    }
  }
}
```

## Server Lifecycle

Language servers are persistent per repository/language/server. Settings shows whether a session is running and exposes a restart action for running or errored sessions.

Diffuse only attempts to attach a language server when opening supported file types for diagnostics. Unsupported file types do not trigger LSP status, diagnostics, or hover requests.

Hover uses an already-attached language server session. Moving the pointer over code does not start a language server by itself.

Restarting a server stops matching sessions. The next supported file open or diagnostics request starts a fresh process.

LSP is currently unavailable on Windows in the core implementation.
