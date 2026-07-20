# pi-subagents

Minimal recursive child-Pi spawner for Pi.

This extension intentionally does **not** define roles, agent types, chains, or parallel task lists. The parent agent supplies the full prompt and instructions for each child.

## Tool

### `spawn_subagent`

Spawn one child Pi process. This is the only exposed model-callable tool.

```ts
spawn_subagent({
  task: string,
  timeout?: number,
  cwd?: string,
  model?: string
})
```

- No wait-for-completion mode exists; calls always return immediately with an ID and resultPath.
- You will be notified when the subagent completes.
- The returned ID is also the child Pi session ID and can be used with Pi session lookup/resume behavior.
- `timeout` is optional (default 600s = 10 minutes) and measured in seconds. When reached, the parent is informed that the child is still running; the child is **not killed**.
- Give `timeout` a healthy margin above expected runtime because child execution time can be wildly unpredictable.
- Subagents always start with fresh session history. Put any desired context explicitly in `task`.
- Child subagent directories contain separate `result.log`, `stdout.log`, and `stderr.log` files.

Completed children are final. Running children continue their original task until completion or failure. The extension exposes only the spawn tool.

## Child environment

Child Pi sessions keep normal Pi capabilities: tools, skills, extensions, and project context are not hidden or restricted by this extension. Every child system prompt receives this identity line:

```text
You are a Pi subagent controlled by another Pi agent.
```

Each child receives a resolved absolute `result.log` path. Pass that literal path to Pi file tools (`write`, `edit`, and `read`), which do not expand shell environment variables. Shell commands and programs may use `$PI_SUBAGENT_RESULT_PATH`; the child runtime also narrowly corrects either exact env-var token when it is accidentally passed as a file-tool path. If the child leaves `result.log` empty, its final assistant message is saved there automatically.

Children may spawn further subagents recursively until the configured recursion-depth limit is reached.

## Removed features

This package no longer supports:

- the old `subagent` mega-tool
- agent types or `agents/*.md`
- custom agent/frontmatter configuration
- chain mode
- parallel task-list mode
- baked-in researcher/reviewer/planner/etc. roles
- status/list public tools
