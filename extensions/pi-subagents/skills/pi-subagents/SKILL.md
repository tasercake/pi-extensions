---
name: pi-subagents
description: Spawn minimal recursive child Pi agents with no predefined roles. Use when delegating a full prompt to another Pi instance, either blocking or async.
---

# Minimal Pi Subagents

Use these tools to launch unrestricted child Pi sessions. The caller must include all role, task, constraints, and output instructions in `task`.

## Tools

- `spawn_subagent({ task, async, keepContext, outputMode, timeout?, cwd?, model? })`
  - `timeout` is optional; default is `3600` seconds (1 hour).
  - Timeout is only a notification threshold: the parent is informed that the child is still running; the child is not killed.
- `get_subagent_status({ id })`
- `list_subagents({})`

## Usage

Blocking:

```ts
spawn_subagent({
  task: "You are a focused reviewer. Inspect ... Return ...",
  async: false,
  timeout: 600, // optional; defaults to 3600
  keepContext: false,
  outputMode: "inline",
});
```

Async/concurrent:

```ts
spawn_subagent({
  task: "Worker A full instructions...",
  async: true,
  timeout: 900,
  keepContext: false,
  outputMode: "inline",
});
spawn_subagent({
  task: "Worker B full instructions...",
  async: true,
  timeout: 900,
  keepContext: false,
  outputMode: "inline",
});
```

Retrieve results:

```ts
get_subagent_status({ id: "..." });
list_subagents({});
```

## Rules

- Available subagent tools are exactly the three listed above.
- No subagent types exist.
- No chain or parallel-list mode exists.
- `timeout` is optional and measured in seconds; omitted timeout defaults to 1 hour.
- When `timeout` expires, the parent is informed that the subagent is still running; the child is not killed.
- Do not kill subagents autonomously to enforce `timeout`.
- Give explicit `timeout` values a healthy margin above expected runtime because child execution time can be wildly unpredictable.
- For async launches, tell the user/caller in second person that they **will be notified** when the subagent completes; do not imply they need to poll.
- If `get_subagent_status` returns `running: true`, do not poll repeatedly; wait for the completion notification.
- Child Pi receives normal tools, skills, extensions, and project context.
- Child Pi gets only one automatic system line: `You are a Pi subagent controlled by another Pi agent.`
- Recursion is allowed until the depth limit is reached.

## Maintenance Procedure

When changing the pi-subagents extension contract, update every surface together:

1. Tool schema in `extensions/pi-subagents/src/extension/schemas.ts`.
2. Runtime defaults/validation and user-facing messages in `extensions/pi-subagents/src/extension/index.ts`.
3. Skill docs in `extensions/pi-subagents/skills/pi-subagents/SKILL.md`.
4. GitHub issues/PR text exactly as requested by the user; do not fabricate details.

For timeout semantics specifically:

- Make schema and runtime agree that `timeout` is optional.
- Apply `timeout ?? 3600` before constructing persisted records or timers.
- Phrase async launch responses in second person: “you will be notified…” when the subagent completes.
- Phrase running status responses to discourage polling and state the caller will be notified on completion.
- Preserve existing timeout behavior: timeout only notifies/marks timeout; it must not kill the child process.
