---
name: pi-subagents
description: Spawn minimal recursive child Pi agents with no predefined roles. Use when delegating a full prompt to another Pi instance, either blocking or async.
---

# Minimal Pi Subagents

Use these tools to launch unrestricted child Pi sessions. The caller must include all role, task, constraints, and output instructions in `task`.

## Tools

- `spawn_subagent({ task, async, keepContext, cwd?, outputMode, model? })`
- `steer_subagent({ id, message })`
- `get_subagent_status({ id })`
- `list_subagents({})`

## Usage

Blocking:

```ts
spawn_subagent({
  task: "You are a focused reviewer. Inspect ... Return ...",
  async: false,
  keepContext: false,
  outputMode: "inline",
});
```

Async/concurrent:

```ts
spawn_subagent({
  task: "Worker A full instructions...",
  async: true,
  keepContext: false,
  outputMode: "inline",
});
spawn_subagent({
  task: "Worker B full instructions...",
  async: true,
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

- No subagent types exist.
- No chain or parallel-list mode exists.
- Child Pi receives normal tools, skills, extensions, and project context.
- Child Pi gets only one automatic system line: `You are a Pi subagent controlled by another Pi agent.`
- Recursion is allowed until the depth limit is reached.
