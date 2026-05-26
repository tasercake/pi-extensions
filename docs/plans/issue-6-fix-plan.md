# Issue 6 Fix Plan: Stale Pi Extension Context in Async Subagent Notifications

## Scope

Repository: `tasercake/pi-extensions` only.

`cc-connect` changes are not needed. The issue evidence shows `cc-connect` only surfaced a Pi extension error; the stale context was created by `pi-subagents` async background notification using a captured session-bound `pi` object after parent session replacement/reload.

## Root Causes Addressed

1. Async `spawn_subagent` completion notification uses captured `ExtensionAPI` after the parent Pi runtime/session may be stale.
2. `pi.sendMessage(..., { triggerTurn: true })` can throw `This extension ctx is stale after session replacement or reload` after child completion.
3. Notification failures must not overwrite or poison the already-persisted child result.
4. Cohort final-notified state must only be persisted after the final notification send succeeds.
5. Disk-backed `get_subagent_status` / `list_subagents` must remain able to retrieve results and retry pending notices after parent reload/replacement.

## Existing Fix Baseline

The current branch already contains the main implementation in `extensions/pi-subagents/src/extension/index.ts`:

- `notifyCompletion()` catches `pi.sendMessage` failures, records a pending notice, and returns `false`.
- `notifyCompletionBestEffort()` ensures notification bookkeeping failures do not turn child success into child failure.
- `runChild()` persists child result before best-effort notification.
- `retryPendingCompletionNotices()` retries pending notices from later tool calls.
- `cohortFinalNotified` is written only after successful final-cohort send.

Current tests in `extensions/pi-subagents/test/unit/minimal-subagents.test.ts` already cover stale single completion, retry via status/list, generic notification failure, and stale non-final cohort notification.

## Surgical Additional Work

Add one missing regression test for the final-cohort failure edge case:

- File: `extensions/pi-subagents/test/unit/minimal-subagents.test.ts`
- New test: when the final cohort completion notification send fails with the stale-context error, both child results remain persisted, both records retain `pendingCompletionNotice=true`, and neither record is marked `cohortFinalNotified`.
- Then verify a later `get_subagent_status` retry can send the final cohort notification and clear pending metadata for both records.

This directly proves root cause #4 for the exact highest-risk branch: `finalCohort === true` and `pi.sendMessage` throws.

## Validation

Run from `extensions/pi-subagents`:

```bash
npm test -- --test-name-pattern='stale|pending|notification|cohort'
npm test
```

If dependencies are missing, install with `npm install` in the worktree only, then rerun tests. Do not modify or commit dependency artifacts unless the package manager intentionally updates tracked lockfiles.

## PR Scope

Open one PR against `tasercake/pi-extensions` referencing and resolving `tasercake/cc-connect#6`.
