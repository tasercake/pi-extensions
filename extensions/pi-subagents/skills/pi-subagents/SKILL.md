---
name: pi-subagents
description: Spawn minimal recursive child Pi agents with no predefined roles. Use when delegating a full prompt to another Pi instance.
---

# Minimal Pi Subagents

Use this tool to launch unrestricted child Pi sessions. The caller must include all role, task, constraints, and output instructions in `task`.

## Tools

- `spawn_subagent({ task, timeout?, cwd?, model? })`
  - Calls return immediately; the parent will be notified when the subagent completes.
  - `model` is an explicit override; omitting it inherits the active parent provider/model.
  - `timeout` is optional; default is `600` seconds (10 minutes).
  - Timeout is only a notification threshold: the parent is informed that the child is still running; the child is not killed.
  - The returned subagent id is also the child Pi session id.
  - Child output is written to `result.log` under the child subagent directory.

## Usage

```ts
spawn_subagent({
  task: "Worker A full instructions...",
  timeout: 900,
});
spawn_subagent({
  task: "Worker B full instructions...",
  timeout: 900,
});
```

Calls return immediately; the parent will be notified when each subagent completes.

## Rules

- Available subagent tool is exactly `spawn_subagent`.
- No wait-for-completion mode exists.
- No subagent types exist.
- No chain or parallel-list mode exists.
- `model` is an explicit override; omitting it inherits the active parent provider/model.
- `timeout` is optional and measured in seconds; omitted timeout defaults to 10 minutes.
- When `timeout` expires, the parent is informed that the subagent is still running; the child is not killed.
- Do not kill subagents autonomously to enforce `timeout`.
- Give explicit `timeout` values a healthy margin above expected runtime because child execution time can be wildly unpredictable.
- Tell the user/caller in second person that they **will be notified** when the subagent completes.
- Child Pi receives normal tools, skills, extensions, and project context.
- Child Pi gets only one automatic system line: `You are a Pi subagent controlled by another Pi agent.`
- Child Pi does not inherit parent session history. Put all parent-provided role context, constraints, and task details explicitly in `task`.
- Subagent final result file is named `result.log`.
- Recursion is allowed until the depth limit is reached.

## Maintenance Procedure

When changing the pi-subagents extension contract, update every surface together:

1. Spawn tool schema in `extensions/pi-subagents/src/extension/schemas.ts`.
2. Spawn runtime defaults/validation and user-facing messages in `extensions/pi-subagents/src/extension/index.ts`.
3. Skill docs in `extensions/pi-subagents/skills/pi-subagents/SKILL.md`.
4. GitHub issues/PR text exactly as requested by the user; do not fabricate details.

For timeout semantics specifically:

- Make schema and runtime agree that `timeout` is optional.
- Apply `timeout ?? 600` before constructing persisted records or timers.
- Phrase launch responses in second person: “you will be notified…” when the subagent completes.
- Preserve existing timeout behavior: timeout only notifies/marks timeout; it must not kill the child process.
