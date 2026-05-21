# Minimal Recursive Pi Subagents Implementation Plan

> `SCOPE.md` is approved and immutable. Do not edit, format, move, rename, or regenerate it. This plan implements that scope. Prefer preserving/refactoring existing working pieces over rewrites, but remove old public concepts that conflict with scope.

## Goal

Refactor vendored `extensions/pi-subagents` into a minimal four-tool child-Pi spawner:

- `spawn_subagent`
- `steer_subagent`
- `get_subagent_status`
- `list_subagents`

No subagent types. No agent markdown. No `AgentConfig`. No chain mode. No parallel task-list mode. Concurrency comes from repeated `spawn_subagent({ async: true, ... })` calls. Child Pi receives normal tools/skills/extensions/project context and only one automatic system-prompt line:

```text
You are a Pi subagent controlled by another Pi agent.
```

## Key current-code hazards to fix

- `src/extension/index.ts` currently exits when `PI_SUBAGENT_CHILD=1`; this disables recursion. Remove/refactor this guard so child Pi registers the four tools until depth limit blocks spawning.
- `src/runs/shared/subagent-prompt-runtime.ts` currently injects restrictive instructions, strips skills/project context, strips the pi-subagents skill, and removes subagent messages. Replace with one-line-only injection.
- `AgentConfig` is deeply coupled into foreground, async, settings, intercom, and chain code. Runtime execution must be refactored to direct child-run specs.
- Result files/status are currently old async/parallel-shaped and may be deleted by watcher. Results must be copied to durable per-parent-session records before notification.
- Slash commands/prompt-template bridges expose old modes. Remove/disable them.

## Phase 0: Baseline and guardrails

1. Work in `/home/exedev/workspaces/default/pi-extensions`.
2. Never touch `SCOPE.md`.
3. Check baseline:
   ```bash
   git status --short
   cd extensions/pi-subagents
   npm install
   npm test || true
   ```
4. Record existing test failures in implementation notes if they are unrelated/environmental.

## Phase 1: Define minimal public API

### Files

- `extensions/pi-subagents/src/extension/index.ts`
- `extensions/pi-subagents/src/extension/schemas.ts`
- `extensions/pi-subagents/src/shared/types.ts`

### Work

1. Stop registering existing `subagent` tool.
2. Register exactly four independent tools:
   - `spawn_subagent`
   - `steer_subagent`
   - `get_subagent_status`
   - `list_subagents`
3. Delete/disable old actions: `list/get/create/update/delete/status/interrupt/resume/doctor` on mega-tool. Status/resume functionality is now exposed only through the new tools.
4. Use `additionalProperties: false` where supported so removed fields (`agent`, `tasks`, `chain`, `config`, `agentScope`, `skill`, `reads`, etc.) are rejected.

### Schemas

```ts
spawn_subagent(params: {
  task: string;
  async: boolean;
  keepContext: boolean;
  cwd?: string;
  outputMode: "inline" | "file";
  model?: string;
});
```

Description must say: when `async: true`, parent can spawn multiple concurrent subagents by calling `spawn_subagent` multiple times.

```ts
steer_subagent(params: { id: string; message: string; });
get_subagent_status(params: { id: string; });
list_subagents(params: {});
```

Return details should match scope shapes, e.g. status details:

```ts
{ id: string; running: boolean; result?: string; error?: string }
```

## Phase 2: Replace AgentConfig runtime with direct child specs

### Files

- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/execution.ts`
- `src/runs/background/async-execution.ts`
- `src/runs/background/subagent-runner.ts`
- `src/runs/shared/parallel-utils.ts` or replacement
- `src/shared/settings.ts`
- `src/intercom/intercom-bridge.ts` if steering still uses it

### New runtime type

```ts
interface ChildRunSpec {
  id: string;
  parentSessionId: string;
  task: string;
  cwd: string;
  keepContext: boolean;
  async: boolean;
  outputMode: "inline" | "file";
  model?: string;
  sessionFile?: string;
  outputFile?: string;
  maxSubagentDepth: number;
}
```

### Work

1. Refactor single foreground run to accept `ChildRunSpec`, not `AgentConfig`.
2. Refactor async runner to accept one `ChildRunSpec`, not steps/agents/chains/parallel groups.
3. Remove all runtime calls to `discoverAgents()` and `discoverAgentsAll()`.
4. Remove model fallback/thinking/default model logic from agent configs. Only caller-provided `model` is passed; otherwise child Pi uses its normal default.
5. Remove default reads/progress/tools/skills/extensions from agent configs.
6. If old render/status code requires a label, use constant internal label `subagent`; it must not affect prompt/tools/model.

## Phase 3: Remove old public concepts and files

### Delete entirely

- `extensions/pi-subagents/agents/`
- `extensions/pi-subagents/prompts/`

### Remove from runtime graph, then delete if straightforward

- `src/agents/agents.ts`
- `src/agents/agent-management.ts`
- `src/agents/agent-selection.ts`
- `src/agents/agent-scope.ts`
- `src/agents/agent-serializer.ts`
- `src/agents/chain-serializer.ts`
- `src/agents/frontmatter.ts`
- `src/agents/identity.ts`
- keep `src/agents/skills.ts` only if reused without AgentConfig semantics; otherwise delete.
- `src/runs/foreground/chain-execution.ts`
- `src/runs/foreground/chain-clarify.ts`
- `src/runs/background/parallel-groups.ts` if only old batch/parallel status
- `src/slash/*`
- `src/extension/doctor.ts` if only old management diagnosis
- prompt-template bridge and slash bridge registrations in `index.ts`

### Required behavior

- No agent types exist.
- No built-in markdown agents exist.
- No user/project agent discovery exists.
- No chain definitions exist.
- No parallel task-list mode exists.
- No slash command exposes old agent/chain/parallel behavior.

## Phase 4: Build child Pi args without restrictions

### File

- `src/runs/shared/pi-args.ts`

### Work

1. Preserve session arguments and task-file logic.
2. Pass `--model` only when caller supplied `model`.
3. Inject the prompt-runtime extension additively.
4. Do not pass or set restrictions:
   - `--no-skills`
   - `--no-extensions`
   - `--tools`
   - `MCP_DIRECT_TOOLS=__none__` or any agent-derived MCP/direct-tool allowlist
   - system-prompt files from agent config
   - inherit skill/project env flags
   - agent-derived thinking/model/tools/skills/extensions/default reads/MCP tools
5. Replace `PI_SUBAGENT_CHILD` if it only existed to disable extension registration. Use a new env only for depth/session metadata if needed.
6. Verify actual Pi CLI semantics: adding `--extension <runtime>` must not suppress normally configured extensions. If it does, use the smallest workaround that preserves normal extensions plus runtime prompt injection.
7. Add tests that child env does not constrain MCP/direct tools and does not set restrictive `MCP_DIRECT_TOOLS` values.

## Phase 5: One-line prompt runtime

### File

- `src/runs/shared/subagent-prompt-runtime.ts`

### Work

1. Replace boundary prompt with:
   ```ts
   export const CHILD_SUBAGENT_SYSTEM_LINE =
     "You are a Pi subagent controlled by another Pi agent.";
   ```
2. Rewrite function:
   ```ts
   export function rewriteSubagentPrompt(prompt: string): string {
     if (prompt.includes(CHILD_SUBAGENT_SYSTEM_LINE)) return prompt;
     return `${CHILD_SUBAGENT_SYSTEM_LINE}\n\n${prompt}`;
   }
   ```
3. Remove/disable:
   - `stripProjectContext`
   - `stripInheritedSkills`
   - `stripSubagentOrchestrationSkill`
   - `PI_SUBAGENT_INHERIT_PROJECT_CONTEXT`
   - `PI_SUBAGENT_INHERIT_SKILLS`
   - “Do not propose or run subagents” text
   - tool-result/message stripping unless proven purely cosmetic and not context/tool hiding. Default: remove it.
4. Keep only session-name plumbing if it does not alter prompt/context/tools.

## Phase 6: keepContext semantics without extra behavioral prompt

### Files

- `src/shared/fork-context.ts`
- `src/shared/types.ts` (`wrapForkTask`, `DEFAULT_FORK_PREAMBLE`)
- child spawn path

### Work

1. `keepContext: true` means true fork of current session.
2. Do not add `DEFAULT_FORK_PREAMBLE` or any automatic task wrapper.
3. Do not filter forked context for project context, skills, subagent tool descriptions, or child tool messages unless a specific internal notification filter is proven harmless.
4. `keepContext: false` starts fresh child Pi session.

## Phase 7: Durable subagent store

### Preferred new file

- `src/runs/background/subagent-store.ts`

### Store path

Use existing subagent runtime/temp/session root if possible. Scope records by parent session ID. Example:

```text
<subagent-runtime-root>/parents/<parentSessionId>/subagents.json
<subagent-runtime-root>/parents/<parentSessionId>/<subagentId>/result.md
<subagent-runtime-root>/parents/<parentSessionId>/<subagentId>/session.jsonl
```

### Record

```ts
interface PersistedSubagentRecord {
  id: string;
  parentSessionId: string;
  cwd: string;
  taskPreview: string;
  keepContext: boolean;
  outputMode: "inline" | "file";
  model?: string;
  running: boolean;
  pid?: number;
  sessionFile?: string;
  outputFile?: string;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  notifiedCompletion?: boolean;
}
```

### Work

1. Write record on spawn before child starts.
2. Update `running/pid/sessionFile/outputFile` as known.
3. On completion, durably write `result` or `outputFile` and `error` before queuing parent notification.
4. `get_subagent_status` reads this store, not transient result JSON.
5. `list_subagents` reads this store and returns all known direct children for current parent session, including completed ones.
6. Ensure result watcher does not delete the only copy of result data. Either do not delete result JSON until copied, or write directly into store from runner.

## Phase 8: Runtime monitoring and control behavior

### Files

- `src/runs/shared/subagent-control.ts`
- `src/runs/shared/completion-guard.ts`
- foreground/async runner integrations

### Work

1. Preserve useful existing monitoring where it does not restrict child capability: running state, long-running/needs-attention detection, failed mutating-tool observation, and completion/result capture.
2. Remove or rewrite any control instructions that tell parent to use old `subagent({ action: ... })` calls. All guidance must reference the new tools (`get_subagent_status`, `steer_subagent`).
3. Replace agent-name-dependent labels with constant child label or subagent ID.
4. Do not inject behavioral restrictions into child prompts as part of monitoring/control.
5. If a guard currently blocks mutation or changes child behavior rather than only observing/reporting, remove or narrow it unless it is solely recursion-depth enforcement.

## Phase 9: Async completion notifications

### Files

- `src/runs/background/notify.ts`
- `src/runs/background/result-watcher.ts`
- `src/intercom/result-intercom.ts` if current parent message injection uses it
- `src/runs/shared/run-history.ts` if reused
- new `subagent-store.ts`

### Work

1. On async child completion, queue a message into parent session after durable store update.
2. Message must include:
   - completed subagent ID
   - instruction: `Call get_subagent_status({ id: "..." }) to retrieve the result.`
3. Track current parent-session async cohort:
   - all async direct children not final-announced
   - active IDs
   - completed IDs
4. If not all concurrent direct children are complete, notification must contain:
   - `N out of M subagents have completed`
   - “You will be notified when all complete.”
5. When all currently tracked direct children complete, queue an all-complete notification and mark cohort final-announced.
6. Keep dedupe safeguards so parent does not receive duplicate completion messages after restart.

## Phase 10: Steering and resume

### Files

- existing async resume/foreground control files if reusable
- `src/runs/background/async-resume.ts`
- `src/intercom/intercom-bridge.ts` if kept
- new store

### Work

1. `steer_subagent({ id, message })` finds record by current parent session and ID.
2. If running:
   - prefer existing live steering if available without agent config;
   - otherwise persist queued message and return acknowledgement that it will be delivered/resumed when possible.
3. If stopped:
   - resume child session with the new message using its persisted session file.
4. Persist pending steer messages if needed.
5. Do not rely on agent prompt/config to inject steering bridge. If live steering requires a runtime extension/intercom channel, make it minimal and independent of AgentConfig.

## Phase 11: Output modes

### Files

- `src/runs/shared/single-output.ts`
- foreground/async run code
- store

### Work

1. Public mode is exactly `"inline" | "file"`.
2. Internally convert to existing helper types only at boundary if needed.
3. There is no public `output` path parameter.
4. For `outputMode: "file"`, generate default result path:
   ```text
   <parent-store>/<subagentId>/result.md
   ```
5. Blocking spawn returns raw result for `inline`, file path for `file`.
6. Async status returns raw result for `inline`, file path for `file`.

## Phase 12: Recursion depth only restriction

### Files

- `src/shared/types.ts`
- `src/runs/shared/pi-args.ts`
- extension registration depth check

### Work

1. Child Pi must register all four subagent tools.
2. Child Pi can call `spawn_subagent` recursively.
3. Depth env increments per child spawn.
4. When depth exhausted, `spawn_subagent` fails clearly.
5. Remove agent-specific depth fields/functions (`maxSubagentDepth` on AgentConfig, `resolveChildMaxSubagentDepth(parent, agentMaxDepth)`) and keep only global/current depth.

## Phase 13: Manifests docs and installer

### Files

- root `package.json`
- `extensions/pi-subagents/package.json`
- `extensions/pi-subagents/README.md`
- `extensions/pi-subagents/skills/pi-subagents/SKILL.md`
- `extensions/pi-subagents/install.mjs`

### Work

1. Root `package.json`: remove `extensions/pi-subagents/prompts` from `pi.prompts` if prompts directory is deleted.
2. Vendored `package.json`:
   - update description to minimal child-Pi spawner
   - remove `pi.prompts`
   - remove `agents/` and `prompts/` from `files`
3. Rewrite README and skill docs to describe exactly four tools and no agent types/chain/parallel list.
4. Docs must state concurrency is repeated `spawn_subagent({ async: true })` calls.
5. Update `install.mjs` messages/help/completion text to advertise the four tools, remove old `subagent`/agent-type wording, and ensure any upstream repo/install references are appropriate for the vendored package.

## Phase 14: Tests

### Delete/rewrite obsolete tests

Remove tests asserting old concepts, including at least:

- `test/unit/agent-disabled.test.ts`
- `test/unit/agent-frontmatter.test.ts`
- `test/unit/agent-management.test.ts`
- `test/unit/agent-overrides.test.ts`
- `test/unit/agent-scope.test.ts`
- `test/unit/agent-selection.test.ts`
- `test/unit/chain-serializer.test.ts`
- `test/unit/prompt-template-bridge.test.ts`
- `test/unit/skills-fallback.test.ts` if agent-skill fallback only
- `test/unit/tool-description.test.ts`
- `test/unit/types-fork-preamble.test.ts`
- `test/integration/chain-clarify.test.ts`
- `test/integration/chain-execution.test.ts`
- `test/integration/parallel-execution.test.ts`
- `test/integration/slash-commands.test.ts`
- `test/integration/slash-live-state.test.ts`
- `test/integration/template-resolution.test.ts`

### Add tests

1. Tool registration exposes exactly four tools.
2. `spawn_subagent` schema requires `task`, `async`, `keepContext`, `outputMode`.
3. Removed fields are rejected: `agent`, `tasks`, `chain`, `config`, `agentScope`, `skill`, `reads`.
4. Child prompt prepends exactly one line.
5. Prompt runtime preserves project context, skill blocks, extension/tool descriptions, and subagent tool docs.
6. Child args never include `--no-skills`, `--no-extensions`, old `--tools` allowlists, or restrictive `MCP_DIRECT_TOOLS` values.
7. Child env still registers four tools.
8. Blocking inline spawn returns raw result.
9. Blocking file spawn creates default result file and returns path.
10. Async spawn returns ID immediately and persists record.
11. Status returns running while active.
12. Status returns final result/path after completion and after watcher/restart.
13. List returns current parent session's known direct children, including completed.
14. Steering running child queues/delivers message.
15. Steering stopped child resumes with message.
16. Async completion notification includes ID and `get_subagent_status` instruction.
17. Concurrent async child partial notification includes `N out of M subagents have completed` and all-complete promise.
18. Child recursive spawn works until depth limit.
19. No `agents/` or `prompts/` package manifest references remain.
20. Old slash commands and old `subagent` tool are not registered.

## Phase 15: Verification

Run:

```bash
cd /home/exedev/workspaces/default/pi-extensions/extensions/pi-subagents
npm install
npm test
```

Targeted examples:

```bash
node --experimental-strip-types --test test/unit/subagent-prompt-runtime.test.ts
node --experimental-strip-types --test test/unit/pi-args.test.ts
node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/single-execution.test.ts
```

Manual smoke:

1. Install local package into Pi.
2. Verify tools list shows exactly four new tools and no old `subagent` tool.
3. Blocking spawn:
   ```ts
   spawn_subagent({
     task: "Reply exactly child-ok",
     async: false,
     keepContext: false,
     outputMode: "inline",
   });
   ```
4. Async concurrent spawn by repeated calls:
   ```ts
   spawn_subagent({
     task: "Say A",
     async: true,
     keepContext: false,
     outputMode: "inline",
   });
   spawn_subagent({
     task: "Say B",
     async: true,
     keepContext: false,
     outputMode: "inline",
   });
   ```
5. Verify completion notifications and `get_subagent_status` retrieval.
6. Restart parent session, verify `list_subagents({})` still works.
7. Verify child can recursively call `spawn_subagent` until depth limit.

## Commit plan

1. `Refactor pi-subagents API to four tools`
2. `Remove agent types chain and parallel modes`
3. `Unrestrict child Pi prompt context and tools`
4. `Persist subagent status results and notifications`
5. `Update tests docs and manifests`

Before final commit:

```bash
git status --short
git diff --stat
npm test
```

Never include changes to `SCOPE.md`.
