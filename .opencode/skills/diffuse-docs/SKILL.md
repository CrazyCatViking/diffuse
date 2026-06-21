---
name: diffuse-docs
description: Use when adding or updating Diffuse documentation, changing feature behavior that needs docs, or touching README.md, AGENTS.md, docs/, or persisted review/LSP/architecture docs.
---

# Diffuse Documentation

Use this skill when a change affects how Diffuse works, how users interact with it, or how contributors integrate with it.

## Documentation Locations

- `README.md` is the GitHub landing page for product overview, installation, usage, development commands, and project status.
- `docs/README.md` is the documentation index.
- `docs/architecture.md` explains high-level architecture for internal development.
- `docs/lsp.md` documents language server configuration, behavior, install actions, and lifecycle.
- `docs/review-spec-v1.md` documents `.diffuse/reviews` persistence and integration contracts.
- `AGENTS.md` contains repository-wide agent/contributor guidance.

## Update Rules

- Update docs in the same change as code when feature behavior changes.
- Prefer updating an existing doc over creating a new one unless the topic is distinct and durable.
- Keep documentation GitHub-native: Markdown files, relative links, no generated site dependency unless the project explicitly adds one.
- Document user-facing changes in user language: what changed, how to use it, and any configuration or environment variables.
- Document contributor-facing changes in implementation language: boundaries, data flow, file formats, build/runtime dependencies, and invariants.
- If persisted files, JSON-RPC contracts, or integration formats change, update the relevant spec before considering the task complete.
- If architecture changes, update `docs/architecture.md` with the new boundary or flow.

## Before Finishing

- Check that new links are relative and point to existing files.
- Check whether `README.md` or `docs/README.md` needs a link to the changed documentation.
- Mention any docs intentionally left unchanged and why.
