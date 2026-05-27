# Issue 6 Fix Plan: durable stale-context timeout notifications

## Scope

Repository: `tasercake/pi-extensions` only.

`cc-connect` is the messenger/trigger surface for the observed Pi extension error, but the confirmed stale-context bug lives in `extensions/pi-subagents`. Current `pi-extensions` main already fixes the original async completion notification failure path; the remaining surgical gap is the delayed async timeout notification path.

## Root causes addressed

Issue #6 root-cause findings require delayed background notifications to tolerate a parent Pi extension context becoming stale after session replacement/reload. Current code handles completion notifications with durable pending state and retry, but timeout notifications still have the same captured-`pi` delayed-send risk:

- `extensions/pi-subagents/src/extension/index.ts:markTimedOut` sets `timeoutNotified = true` before a timeout notification is successfully sent.
- `notifyTimeout` catches `pi.sendMessage` failure and returns `false`, so stale ctx errors are non-fatal, but the timeout notice is silently lost and will not be retried.
- This misses the issue-context direction to apply stale-context handling to all delayed background notifications, including timeout paths.

## Concrete implementation

1. Update `extensions/pi-subagents/src/extension/index.ts`.
   - Extend `PersistedSubagentRecord` with durable timeout notification bookkeeping:
     - `pendingTimeoutNotice?: boolean`
     - `timeoutNotifyError?: string`
     - `timeoutNotifiedAt?: number`
   - Split timeout occurrence from timeout notification success:
     - `markTimedOut(record)` records `timeoutAt` and pending timeout notice state, but does not set `timeoutNotified = true`.
     - Preserve idempotence and existing `timedOut` status semantics via `timeoutAt`.
   - Add timeout notice helpers analogous to completion helpers:
     - `markTimeoutNoticePending(record, error?)`
     - `markTimeoutNoticeSent(record)`
   - Change `notifyTimeout(pi, record)` so it:
     - marks/refreshes timeout state,
     - skips notification if the child is no longer running,
     - on `sendMessage` failure persists pending timeout notice and error without marking success,
     - on success clears pending/error state and sets `timeoutNotified = true`/`timeoutNotifiedAt`.
   - Add `retryPendingTimeoutNotices(pi, parentId)` and call it from live tool executions alongside `retryPendingCompletionNotices` in:
     - `spawn_subagent.execute`,
     - `get_subagent_status.execute`,
     - `list_subagents.execute`.
   - Retry only while the child is still running and has `timeoutAt`; do not send stale timeout notices after a child has completed.

2. Add regression coverage in `extensions/pi-subagents/test/unit/minimal-subagents.test.ts`.
   - Test stale async timeout notification remains pending and is retried by the next live tool call:
     - spawn an async child with a very short timeout and delayed completion,
     - make the initial timeout `sendMessage` throw `This extension ctx is stale after session replacement or reload`,
     - assert the record has `timeoutAt`, pending timeout notice state, no `timeoutNotified`, and recorded error,
     - execute a later status/list call with a live `pi`,
     - assert exactly one timeout message is sent, pending state clears, and the child eventually completes successfully.
   - Test no timeout retry is sent after the child has already completed:
     - create the same stale pending timeout state,
     - wait for child completion before the next live tool call,
     - assert no timeout retry message is sent for the completed child and result remains successful.

## Validation

Run from the worktree:

```bash
cd extensions/pi-subagents
npm test
```

Also run any available package typecheck/format script if present in `package.json`.

## Non-goals

- No `cc-connect` code changes.
- No issue comments/labels/state changes.
- No broad notification redesign beyond durable timeout notification retry semantics.
