# Diffuse Architecture Refactor Report

This report captures the current architecture assessment and the recommended cleanup plan after the initial fast implementation phase.

## Current Architecture

Diffuse has a sound high-level split:

- `core/` is a Zig executable that owns Git access, repository session state, diff parsing, Tree-sitter syntax work, LSP sessions, review persistence, filesystem watching, and JSON-RPC handling.
- `app/` is an Electron/Vue desktop app that owns windows, dialogs, renderer state, UI rendering, settings, provider adapters, and communication with the core process.
- The app starts one Zig core process per Electron window and communicates over line-delimited JSON-RPC on stdin/stdout.
- Review state is persisted as plain JSON and Markdown under `.diffuse/reviews`.

The coarse boundary is good. Most of the architectural debt is inside the boundaries and at the app/core protocol seam.

## Core Findings

The core is organized into useful coarse modules:

- `core/src/app/cli.zig` handles CLI dispatch and release/install helpers.
- `core/src/app/rpc_server.zig` runs the line-delimited JSON-RPC server and dispatches requests concurrently.
- `core/src/app/rpc_runtime.zig` owns shared runtime state, locks, syntax/LSP caches, session state, repository watcher, and outbound queue.
- `core/src/app/rpc_handlers.zig` registers and implements the current RPC surface.
- `core/src/core/repository.zig` is the Git boundary.
- `core/src/core/diff.zig` parses unified diffs and builds render models.
- `core/src/core/syntax.zig` owns Tree-sitter registry, cache, installation, and highlighting.
- `core/src/core/lsp.zig` owns LSP configuration, lifecycle, hover, and diagnostics.
- `core/src/core/review.zig` owns review persistence.
- `core/src/protocol/*` owns JSON-RPC and wire DTO helpers.

Primary risks:

- `rpc_handlers.zig` mixes routing, param parsing, JSON conversion, domain operations, events, review persistence, LSP orchestration, and Tree-sitter installation progress.
- Long operations often run while holding broad runtime locks.
- Review persistence path safety was not centralized for all IDs used as path segments.
- JSON-RPC errors were coarse and most handler failures became `-32000` with internal Zig error names.
- There was no `zig build test` step.

## App Findings

The app has a reasonable flow:

- Electron main owns windows and a `CoreRpcClient` per window.
- Preload exposes `window.diffuse`.
- Renderer calls core through `app/src/lib/useClient.ts`.
- Pinia stores own the major app domains: repository, diff, review, and settings.
- Diff rendering is virtualized and syntax/LSP data is loaded lazily in the main diff view.

Primary risks:

- `DiffViewer.vue` and `FolderDiffViewer.vue` are very large and duplicate syntax, LSP, review-row, selection, diagnostics, hover, and scroll-marker logic.
- State ownership is sometimes mixed between stores and components.
- Core-event subscriptions are ad hoc.
- Frontend RPC types, method names, and Electron whitelists were manually duplicated.
- There are no app unit/component tests or lint script.

## Contract Findings

The app/core boundary is the highest leverage cleanup area.

Current contract sources include:

- Zig DTOs in `core/src/protocol/types.zig`.
- TypeScript DTOs in `app/src/lib/protocol.ts`.
- Zig method registration in `core/src/app/rpc_handlers.zig`.
- Electron method whitelist in `app/electron/main.ts`.
- Renderer wrappers in `app/src/lib/useClient.ts`.
- Event payload assumptions in renderer stores.
- Review persistence docs in `docs/review-spec-v1.md`.

Primary risks:

- Method lists can drift silently.
- Optional/null policy was not consistently expressed between Zig and TypeScript.
- Event shapes were under-specified, especially `review/changed`.
- Param validation was mostly manual and inconsistent.
- Review JSON is intentionally pass-through in many places, so IDs and path segments must be strongly validated at the persistence boundary.

## Recommended Refactor Plan

Prioritize safety and contract stability before reshaping modules or UI components.

1. Centralize review path-segment validation for every ID used in persistence paths.
2. Add a `zig build test` step and tests for validation and pure protocol helpers.
3. Add stricter RPC parameter helpers for required strings, objects, enums, and positive integers.
4. Convert high-risk review RPC handlers to the stricter helpers.
5. Improve JSON-RPC error mapping and preserve error code/details in the app.
6. Add a frontend `CoreMethods` map for typed method params/results.
7. Derive or check Electron `allowedCoreMethods` from the same method map.
8. Normalize TypeScript optional/null fields to match Zig serialization.
9. Define typed core event contracts and use them in the bridge/stores.
10. After the boundary is stable, split `rpc_handlers.zig` by domain.

## Later Refactors

After the contract and safety work is in place:

- Split `rpc_handlers.zig` into repository, diff, syntax, LSP, review, params, and events modules.
- Reduce core lock hold times around Git, syntax, LSP, and filesystem operations.
- Extract shared diff-viewer composables such as `useSyntaxSpans`, `useLspHover`, `useLspDiagnostics`, `useReviewRows`, `useDiffScrollMarkers`, and `useSelectionReviewDraft`.
- Unify single-file and folder diff syntax loading so folder diffs do not eagerly load large ranges.
- Add targeted app tests for file tree sorting, review row insertion, syntax span fragmentation, and search matching.
- Add design tokens for repeated app chrome colors.
