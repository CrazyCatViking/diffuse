# Phase 0 Baselines

This document records the baseline environment and capture procedure for Phase 0 of the [Agent Workbench design](agent-workbench-design.md). Performance results are workstation-specific and are not CI pass/fail thresholds until repeated on the supported platform matrix.

## Reference Environment

| Field | Value |
| --- | --- |
| Date | 2026-08-23 |
| Base revision | `c043570` plus Phase 0 working-tree changes |
| OS | Arch Linux, kernel `7.1.8-arch1-3`, x86-64 |
| CPU | AMD Ryzen 9 3900X, 12 cores / 24 threads |
| Memory | 31 GiB |
| Display | Wayland |
| Zig | 0.16.0 |
| Node | 20.19.5 |
| pnpm | 11.4.0 |

## Correctness Baseline

The deterministic RPC fixture creates a Git repository with a fixed commit identity and timestamp, then adds staged, unstaged, renamed, and deleted files. `pnpm test:integration` runs the current Zig JSON-RPC executable against that fixture and covers:

- Standard method-not-found and invalid-params errors.
- Repository opening and diff-target defaults.
- Changed-file listing and inline diff rendering.
- Review session and progress persistence with `review/changed` events.
- Search start, result, progress, and completion events under an explicit search ID.

The initial reference run completed 5 integration tests in 553 ms wall time as reported by Vitest. The app unit baseline completed 23 tests in 301 ms wall time. These durations are smoke-test observations, not product latency budgets.

## Performance Capture Matrix

Use a release-safe core and a packaged Electron app. Capture at least five warm runs after one discarded cold run, with no debugger attached. Record median and p95 where repeated samples are available.

| Measure | Start | Stop | Required fixture or state |
| --- | --- | --- | --- |
| Electron startup | Process spawn | Primary renderer `did-finish-load` and first repository overview paint | Deterministic medium repository, no agent process |
| Idle memory | Five minutes after the first stable paint | One operating-system process-tree RSS sample | Same repository, window focused, no interaction |
| Large-diff interaction | Request or navigation input | Diff rows painted and keyboard navigation responsive | Deterministic large text diff in split and inline modes |
| Event throughput | First emitted event | Last renderer-applied event, including queue drain | Fixed batches of valid search and agent activity events |
| Agent run | Start action | First visible activity, first finding, and terminal state | Fixed provider/model/config and assigned file set |

For each capture, record the exact revision, build mode, OS, CPU, memory, fixture revision, sample count, median, p95, and any provider/network dependency. Agent measurements must identify remote-provider variance and must not record prompts, credentials, or hidden reasoning.

## Capture Status

The correctness and RPC lifecycle baselines are recorded above. Electron startup, idle memory, large-diff interaction, renderer event throughput, and provider-backed agent-run measurements are deferred because an instrumented packaged build and supported-platform access are not currently available. This does not block Phase 1. These measurements and an initial regression budget must be established before Phase 7 performance exit criteria can be evaluated.
