# Scope: Minimal Recursive Pi Subagents

## Objective

Simplify the vendored `pi-subagents` extension into a minimal child-Pi spawner. The extension should provide only the mechanics for launching, steering, listing, and checking child Pi instances; all role, behavior, and task instructions must come from the caller's prompt.

## Constraints and Guidelines

- Where a scope item is already met by the current extension, prefer preserving, modifying, or refactoring existing functionality instead of ripping it out and rebuilding from scratch.
- Prefer simplicity over complexity.

## Required Functionality

- Expose exactly four tools:
  - `spawn_subagent`
  - `steer_subagent`
  - `get_subagent_status`
  - `list_subagents`
- `spawn_subagent` supports exactly two run modes through `async`:
  - blocking when `async: false`
  - asynchronous/non-blocking when `async: true`
- The `spawn_subagent` tool description must clearly state that when `async: true`, the parent can spawn multiple concurrent subagents by calling `spawn_subagent` multiple times.
- Remove parallel batch mode. If a parent wants multiple subagents, it should call `spawn_subagent` multiple times.
- Remove chain/sequential-pipeline execution entirely.
- Remove the concept of subagent types entirely.
- Delete all built-in agent markdown definitions.
- Remove custom agent/frontmatter configuration as a user-facing concept.
- Treat project context and skills as always inherited/enabled.
- Do not hide or restrict tools, skills, extensions, project context, or other normal Pi capabilities from child subagents.
- Inject exactly one minimal system-prompt line into child Pi sessions:
  - `You are a Pi subagent controlled by another Pi agent.`
- Add no other baked-in behavioral instructions to child subagents.
- Preserve recursion: child subagents may spawn further subagents, limited only by recursion-depth controls.
- Persist subagent metadata/results to disk so `list_subagents` and `get_subagent_status` work across parent session restarts.
- When an asynchronous subagent completes, queue a notification message on the parent session containing:
  - the completed subagent's ID
  - an instruction to use `get_subagent_status` to retrieve the result
- If other concurrent direct-child subagents from the same parent session are still active when a subagent completes, the queued parent notification must clearly state:
  - `N out of M subagents have completed`
  - that the parent will be notified when all complete

## Tool Schemas

### `spawn_subagent`

Spawn a new subagent. When `async: true`, this returns immediately, allowing the parent to spawn multiple concurrent subagents by calling `spawn_subagent` multiple times.

```ts
spawn_subagent(params: {
  task: string;             // Instructions provided by parent.
  async: boolean;           // false blocks parent until done; true returns immediately.
  keepContext: boolean;     // true creates a true fork of current session; false starts fresh.
  cwd?: string;             // Optional working directory. Defaults to parent's.
  outputMode: "inline" | "file"; // inline returns result directly; file returns path to result file.
  model?: string;           // Optional model override for subagent session.
});
```

### `steer_subagent`

Send a message to a subagent. If running, message is queued. If stopped, it is resumed with the new message.

```ts
steer_subagent(params: {
  id: string;
  message: string;
});
```

### `get_subagent_status`

Get subagent status.

```ts
get_subagent_status(params: {
  id: string;
}) -> {
  id: string;
  running: boolean;
  result?: string; // Raw result or output file path, if available.
  error?: string;
};
```

### `list_subagents`

List subagents for the current parent session. Data persists across parent session restarts.

```ts
list_subagents(params: {}) -> Array<{
  id: string;
  running: boolean;
}>;
```

## Non-Goals

- No specialized roles like researcher, reviewer, planner, scout, worker, or delegate.
- No single mega `subagent` tool.
- No parallel task-list mode.
- No chain mode, chain definitions, chain prompt templates, or `{previous}`/`{chain_dir}` templating.
- No default reads, default tools, default skills, default models, or default role prompts from agent definitions.
- No prompt rewriting beyond the single control-notification line.
- No restrictions that prevent recursive subagent use except explicit depth limits.

## Success Criteria

- `spawn_subagent({ task, async: false, keepContext, outputMode })` runs one unrestricted child Pi and blocks until completion.
- `spawn_subagent({ task, async: true, keepContext, outputMode })` starts one unrestricted child Pi and returns its ID immediately.
- Parent agents can create multiple concurrent subagents by calling `spawn_subagent` repeatedly with `async: true`.
- `steer_subagent({ id, message })` queues a message for a running subagent or resumes a stopped subagent with that message.
- `get_subagent_status({ id })` reports running state plus final result or error when available.
- `list_subagents({})` lists current-session subagents after parent session restart.
- Async completion notifications are queued into the parent session and direct the parent to call `get_subagent_status` for results.
- Partial completion notifications for concurrent direct children include `N out of M subagents have completed` and say the parent will be notified when all complete.
- Calls using agent types, parallel task lists, chains, agent management, or custom subagent type configuration are unsupported or removed.
- Child Pi sessions retain normal Pi tools, skills, extensions, and project context.
- Child Pi sessions can call `spawn_subagent` recursively until the configured depth limit is reached.
- The only automatic child-system-prompt addition is the one required line above.
