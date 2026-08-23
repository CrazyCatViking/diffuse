# Diffuse Documentation

This directory contains the project documentation that should be readable directly in GitHub.

## Current Docs

| Document | Audience | Purpose |
| --- | --- | --- |
| [`architecture.md`](architecture.md) | Contributors | High-level map of app/core boundaries, runtime flow, persistence, and build wiring. |
| [`agent-workbench-design.md`](agent-workbench-design.md) | Contributors | Target single-window Agent Workbench architecture, workspace attention model, Rust/N-API design, and phased implementation plan. |
| [`phase-0-baselines.md`](phase-0-baselines.md) | Contributors | Phase 0 correctness baseline, reference environment, and repeatable performance capture matrix. |
| [`amazing-file-search-plan.md`](amazing-file-search-plan.md) | Contributors | Full implementation plan for the unified changed-file search, global palette, and pinned results drawer. |
| [`design-system.md`](design-system.md) | Contributors | Design tokens, shared UI primitives, feature UI patterns, and frontend implementation rules. |
| [`refactor-report.md`](refactor-report.md) | Contributors | Current architecture assessment, risks, and prioritized cleanup plan. |
| [`lsp.md`](lsp.md) | Users and contributors | Language server configuration, built-in defaults, diagnostics, install actions, and lifecycle. |
| [`review-spec-v1.md`](review-spec-v1.md) | Contributors and integrations | File layout and JSON formats for `.diffuse/reviews`. |

The top-level [`README.md`](../README.md) is the GitHub landing page for installation, usage, and project status.

## Documentation Rules

Update documentation in the same change as code when feature behavior changes.

Use this directory for durable docs:

- Add or update user-facing docs when commands, settings, UI behavior, environment variables, install steps, or workflows change.
- Update [`architecture.md`](architecture.md) when process boundaries, app/core responsibilities, persistence, JSON-RPC flow, or build wiring changes.
- Update [`agent-workbench-design.md`](agent-workbench-design.md) while implementing or revising the target workspace, attention, Rust core, ACP, or migration design.
- Update specs like [`review-spec-v1.md`](review-spec-v1.md) when persisted formats or integration contracts change.
- Update [`lsp.md`](lsp.md) when LSP configuration, server lifecycle, diagnostics, hover behavior, or install actions change.
- Keep links relative so docs work in GitHub, local editors, and checked-out source trees.
