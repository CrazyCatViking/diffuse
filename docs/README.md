# Diffuse Documentation

This directory contains the project documentation that should be readable directly in GitHub.

## Current Docs

| Document | Audience | Purpose |
| --- | --- | --- |
| [`architecture.md`](architecture.md) | Contributors | Delivered native ACP, main-owned review waves, immutable scopes, Windows/Unix containment, event recovery and verification limits. |
| [`agent-workbench-design.md`](agent-workbench-design.md) | Contributors | Target single-window Agent Workbench architecture, workspace attention model, Rust/N-API design, and phased implementation plan. |
| [`phase-0-baselines.md`](phase-0-baselines.md) | Contributors | Phase 0 correctness baseline, reference environment, and repeatable performance capture matrix. |
| [`amazing-file-search-plan.md`](amazing-file-search-plan.md) | Contributors | Full implementation plan for the unified changed-file search, global palette, and pinned results drawer. |
| [`design-system.md`](design-system.md) | Contributors | Tokens, shared primitives, Agent session/input/settings and review-wave UI patterns, and frontend rules. |
| [`refactor-report.md`](refactor-report.md) | Contributors | Historical pre-workbench architecture assessment, risks, and prioritized cleanup plan. |
| [`lsp.md`](lsp.md) | Users and contributors | Language server configuration, built-in defaults, diagnostics, install actions, and lifecycle. |
| [`review-spec-v1.md`](review-spec-v1.md) | Contributors and integrations | Portable and legacy file formats, retired runner history and explicit adapter migration guidance. |
| [`review-spec-v2.md`](review-spec-v2.md) | Contributors and integrations | Phase 5 guarantees, schema 7 literal-ID compatibility and immutable scopes, main-owned waves, queues/history/replay and recovery. |

The top-level [`README.md`](../README.md) is the GitHub landing page for installation, usage, and project status.

## Documentation Rules

Update documentation in the same change as code when feature behavior changes.

Use this directory for durable docs:

- Add or update user-facing docs when commands, settings, UI behavior, environment variables, install steps, or workflows change.
- Update [`architecture.md`](architecture.md) when process boundaries, app/core responsibilities, persistence, JSON-RPC flow, or build wiring changes.
- Update [`agent-workbench-design.md`](agent-workbench-design.md) while implementing or revising the target workspace, attention, Rust core, ACP, or migration design.
- Update [`review-spec-v1.md`](review-spec-v1.md) for retained file formats and [`review-spec-v2.md`](review-spec-v2.md) for hybrid ownership, migration, and device-local persistence contracts.
- Update [`lsp.md`](lsp.md) when LSP configuration, server lifecycle, diagnostics, hover behavior, or install actions change.
- Keep links relative so docs work in GitHub, local editors, and checked-out source trees.
