# Issue 6 TODO

Parent-managed checklist for `docs/plans/issue-6-fix-plan.md`.

- [x] Implement durable timeout notification pending/sent bookkeeping in `extensions/pi-subagents/src/extension/index.ts`.
- [x] Add retry of pending timeout notifications from spawn/status/list live tool executions.
- [x] Add regression tests for stale timeout notification retry and no retry after completion.
- [x] Run package validation (`PI_SUBAGENT_DEPTH=0 npm test`; inherited subagent depth otherwise blocks mock child runs).
- [x] Review git status for original repo and worktree.
- [x] Commit and push branch.
- [ ] Open PR referencing and resolving `tasercake/cc-connect#6`.
- [ ] Verify PR diff/tests/mergeability, then merge PR at the end.
