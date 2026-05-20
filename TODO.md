# TODO: Minimal Recursive Pi Subagents

> Orchestrator-owned checklist. Implementation/reviewer subagents must not edit this file, `PLAN.md`, or `SCOPE.md`.

## Planning and setup

- [x] Create implementation branch `simplify-pi-subagents-four-tools`.
- [x] Create this orchestrator-owned checklist.
- [x] Commit approved scope/plan/checklist before code changes.

## Implementation workstreams

- [x] API surface: replace old `subagent` mega-tool with exactly four tools: `spawn_subagent`, `steer_subagent`, `get_subagent_status`, `list_subagents`.
- [x] Runtime model: remove `AgentConfig` from execution path and use direct child-run specs.
- [x] Delete/remove old public concepts: agent markdown/types, agent management, chain mode, parallel task-list mode, slash/prompt-template surfaces.
- [x] Child spawning: preserve full Pi capability; no tool/skill/extension/project-context restrictions except recursion depth.
- [x] Prompt runtime: inject exactly one child system line and no other behavioral prompt/context rewriting.
- [x] `keepContext`: implement true fork vs fresh session without extra behavioral preamble or filtering.
- [x] Durable store: persist subagent metadata/results by parent session for status/list across restarts.
- [x] Async completion notifications: queue parent messages with ID/status instruction and `N out of M` partial completion messaging.
- [x] Steering/resume: implement `steer_subagent` for running and stopped children.
- [x] Output modes: implement `inline` and generated `file` result modes.
- [x] Recursion depth: child subagents can recursively spawn until depth limit; depth errors are clear.
- [x] Docs/manifests/installer: update README, skill doc, package manifests, installer messages.
- [x] Tests: remove obsolete tests and add focused tests for new scope.

## Review gates

- [ ] Neutral reviewer passes API/runtime refactor. (Skipped per user instruction not to use subagents.)
- [ ] Neutral reviewer passes unrestricted child prompt/args/context behavior. (Skipped per user instruction not to use subagents.)
- [ ] Neutral reviewer passes persistence/notifications/steering behavior. (Skipped per user instruction not to use subagents.)
- [ ] Neutral reviewer passes docs/manifests/tests. (Skipped per user instruction not to use subagents.)

## Verification

- [x] Run vendored test suite or documented targeted tests.
- [ ] Manual smoke: blocking inline spawn. (Not run yet.)
- [ ] Manual smoke: async spawn + status/list. (Not run yet.)
- [ ] Manual smoke: repeated async spawn notifications. (Not run yet.)
- [ ] Manual smoke: recursive spawn until depth limit. (Not run yet.)

## Delivery

- [ ] Commit implementation changes.
- [ ] Push branch.
- [ ] Open pull request.
- [ ] Run one reviewer subagent on PR and have it leave comments directly on GitHub.
