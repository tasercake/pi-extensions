---
name: pi-subagents
description: Spawn minimal recursive child Pi agents with no predefined roles. Use when delegating a full prompt to another Pi instance.
---

# Minimal Pi Subagents

Use this tool to launch unrestricted child Pi sessions. The caller must include all role, task, constraints, and output instructions in `task`.

## Tools

- `spawn_subagent({ task, cwd?, model? })`
  - Calls return immediately; the parent will be notified when the subagent completes.
  - `model` is an explicit override; omitting it inherits the active parent provider/model.
  - The returned subagent id is also the child Pi session id.
  - Child output is written to `result.log` under the child subagent directory.
  - When `model` is omitted, the child inherits the parent session's active model (e.g., `openai-codex/gpt-5.6-sol`). Pass an explicit `model` to override (e.g., `"anthropic/claude-sonnet-4-5"`).
- `list_subagents({})`
  - Returns persisted subagent ids and latest running state for the current parent session.
- `get_subagent_status({ id })`
  - Returns one status snapshot and result path for a spawned subagent.
- `tail_subagent({ id, lines? })`
  - Returns recent complete NDJSON lines from child stdout (`lines` defaults to 20; maximum 200).
  - Omits a trailing partial line that the child may still be writing.

## Usage

```ts
spawn_subagent({
  task: "Worker A full instructions...",
});
spawn_subagent({
  task: "Worker B full instructions...",
});
```

Calls return immediately; the parent will be notified when each subagent completes.

## Rules

- Inspection tools are read-only snapshots. Do not build polling or sleep loops around them; completion still sends a notification.
- No wait-for-completion mode exists.
- No subagent types exist.
- No chain or parallel-list mode exists.
- `model` is an explicit override; omitting it inherits the active parent provider/model.
- Tell the user/caller in second person that they **will be notified** when the subagent completes.
- Child Pi receives normal tools, skills, extensions, and project context.
- Child Pi gets only one automatic system line: `You are a Pi subagent controlled by another Pi agent.`
- Child Pi does not inherit parent session history. Put all parent-provided role context, constraints, and task details explicitly in `task`.
- Subagent final result file is named `result.log`.
- Recursion is allowed until the depth limit is reached.

## Maintenance Procedure

When changing the pi-subagents extension contract, update every surface together:

1. Tool schemas in `extensions/pi-subagents/src/extension/schemas.ts`.
2. Tool runtime validation and user-facing messages in `extensions/pi-subagents/src/extension/index.ts`.
3. Skill docs in `extensions/pi-subagents/skills/pi-subagents/SKILL.md`.
4. GitHub issues/PR text exactly as requested by the user; do not fabricate details.

Phrase launch responses in second person: “you will be notified…” when the subagent completes.
