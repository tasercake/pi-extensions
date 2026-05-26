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
  timeout?: number,
  keepContext: boolean,
  cwd?: string,
  outputMode: "inline" | "file",
  model?: string
})
```

- `async: false` blocks until the child finishes.
- `async: true` returns immediately with an ID. Spawn multiple concurrent subagents by calling `spawn_subagent` multiple times.
- `timeout` is optional (default 3600s = 1 hour) and measured in seconds. When reached, the parent is informed that the child is still running; the child is **not killed**.
- Give `timeout` a healthy margin above expected runtime because child execution time can be wildly unpredictable.
- `keepContext: true` forks the current Pi session.
- `keepContext: false` starts a fresh child session.
- `outputMode: "inline"` stores/returns the child result text.
- `outputMode: "file"` writes the child result to a generated file and returns the file path.

### `get_subagent_status`

```ts
get_subagent_status({ id: string });
```

Returns:

```ts
{ id: string, running: boolean, result?: string, error?: string }
```

If the subagent is still running, the response includes a strong instruction not to poll.

`result` is either raw text or a result-file path, depending on `outputMode`.

### `list_subagents`

```ts
list_subagents({});
```

Lists subagents for the current parent session. Records are persisted on disk across parent session restarts.

Completed children are final. Running children continue their original task until completion or failure. The extension exposes only spawn, status, and list tools.

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
