# pi-subagents

Minimal recursive child-Pi spawner for Pi.

This extension intentionally does **not** define roles, agent types, chains, or parallel task lists. The parent agent supplies the full prompt and instructions for each child.

## Tools

### `spawn_subagent`

Spawn one child Pi process.

```ts
spawn_subagent({
  task: string,
  async: boolean,
  keepContext: boolean,
  cwd?: string,
  outputMode: "inline" | "file",
  model?: string
})
```

- `async: false` blocks until the child finishes.
- `async: true` returns immediately with an ID. Spawn multiple concurrent subagents by calling `spawn_subagent` multiple times.
- `keepContext: true` forks the current Pi session.
- `keepContext: false` starts a fresh child session.
- `outputMode: "inline"` stores/returns the child result text.
- `outputMode: "file"` writes the child result to a generated file and returns the file path.

### `steer_subagent`

```ts
steer_subagent({ id: string, message: string })
```

Queues a message for a running subagent or resumes a stopped subagent with the message.

### `get_subagent_status`

```ts
get_subagent_status({ id: string })
```

Returns:

```ts
{ id: string, running: boolean, result?: string, error?: string }
```

`result` is either raw text or a result-file path, depending on `outputMode`.

### `list_subagents`

```ts
list_subagents({})
```

Lists subagents for the current parent session. Records are persisted on disk across parent session restarts.

## Child environment

Child Pi sessions keep normal Pi capabilities: tools, skills, extensions, and project context are not hidden or restricted by this extension. The only automatic child-system-prompt addition is:

```text
You are a Pi subagent controlled by another Pi agent.
```

Children may spawn further subagents recursively until the configured recursion-depth limit is reached.

## Removed features

This package no longer supports:

- the old `subagent` mega-tool
- agent types or `agents/*.md`
- custom agent/frontmatter configuration
- chain mode
- parallel task-list mode
- baked-in researcher/reviewer/planner/etc. roles
