# Steering Removal Scope

## Product decision

`pi-subagents` will not support steering or follow-up messages to existing child agents.

Subagents are task runners: parent agents spawn them, then inspect results. They are not interactive chat sessions.

## Goals

- Keep the subagent feature small, predictable, and easy to reason about.
- Preserve reliable child execution for synchronous and asynchronous tasks.
- Avoid pretending that a running child can receive non-interrupting live messages when the product does not need that behavior.
- Reduce user-facing API surface to the primitives that are actually useful.

## In scope

The supported user-facing capabilities are:

1. Spawn a child Pi agent for one complete task.
2. Choose whether spawning blocks or runs asynchronously.
3. Choose whether the child starts fresh or inherits parent context.
4. Choose inline result or result-file output.
5. Check status/result for a spawned child.
6. List spawned children for the current parent session.

## Out of scope

The product will not support:

- Sending follow-up messages to a running child.
- Sending follow-up messages to a completed child.
- Pausing, interrupting, nudging, or resuming a child through a steering command.
- Per-child steering queues.
- Child acknowledgement of steering messages.
- User-facing steering state, history, or delivery guarantees.

## User-facing tool surface

The intended tool surface is limited to:

- `spawn_subagent`
- `get_subagent_status`
- `list_subagents`

No steering tool should be presented to the model or documented for users.

## Expected behavior

### Synchronous child

When a parent spawns a synchronous child, the parent waits for the child to finish and receives the result.

### Asynchronous child

When a parent spawns an asynchronous child, the parent receives a child identifier immediately. The parent can later inspect status or result using that identifier.

### Completed child

A completed child is final. The parent may read its result, but may not send it additional instructions through the subagent extension.

### Running child

A running child continues its original task until completion or failure. The parent may inspect status, but may not send it additional instructions through the subagent extension.

## Non-goals

This change is not intended to create a general multi-agent chat framework, interactive child sessions, live process control, or orchestration workflows beyond spawn/status/list.

## Success criteria

- The subagent API is understandable without explaining steering semantics.
- No user-facing docs mention steering.
- No model-visible tool exists for steering.
- Existing spawn, status, and list workflows remain reliable.
- Running children are never interrupted as a side effect of unsupported follow-up behavior.
