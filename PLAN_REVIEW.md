# PLAN.md Deep Review Against Current Vendored Code

## Critical gaps

1. **Child recursion is currently disabled at extension registration.**
   - `src/extension/index.ts` returns immediately when `PI_SUBAGENT_CHILD=1`.
   - `buildPiArgs()` always sets that env for children.
   - Net effect: child Pi will not register any subagent tools, directly violating recursive spawn except depth.
   - PLAN says do not filter subagent tools, but does not explicitly require removing/refactoring this guard.

2. **Current child prompt runtime violates scope in multiple ways.**
   - `subagent-prompt-runtime.ts` injects five boundary lines, including “Do not propose or run subagents”. Scope wants exactly one line.
   - It can strip project context and skills via env flags.
   - It always strips the `pi-subagents` skill.
   - It strips parent subagent tool calls/results and custom notification messages from forked transcripts. This may hide context; current plan only says “audit” rather than requiring removal unless proven harmless.

3. **AgentConfig dependency is much deeper than PLAN states.**
   - Runtime paths depend on `AgentConfig` in `foreground/subagent-executor.ts`, `foreground/execution.ts`, `background/async-execution.ts`, `foreground/chain-execution.ts`, `shared/settings.ts`, `intercom/intercom-bridge.ts`, and TUI clarify code.
   - Deleting/bypassing `src/agents/*` alone will break these imports.
   - Scope says “no AgentConfig”; plan needs explicit refactor of `runSync`, async runner config, model/skills/default reads/output behavior, and intercom bridge away from agent configs.

4. **No synthetic minimal child runner design exists.**
   - Current execution requires `agent` lookup, `systemPrompt`, `tools`, `extensions`, `inheritProjectContext`, `inheritSkills`, `skills`, `defaultReads`, output behavior, etc.
   - To preserve subprocess/status functionality without AgentConfig, plan needs a concrete `ChildRunSpec`/`RunnerSubagentStep` replacement and direct `runPi` entrypoint using only task/cwd/model/session/output/depth.

5. **Output mode mapping is wrong/incomplete.**
   - Current type is `"inline" | "file-only"`; scope wants `"inline" | "file"`.
   - Current file behavior requires separate `output` path. Scope schema has no `output` param.
   - Plan says map `outputMode: "file"` to existing file-output machinery, but does not define default result-file path generation or how to return only path.

6. **Async result retrieval is currently unsafe.**
   - `result-watcher.ts` deletes result JSON after emitting completion event.
   - `status.json` does not persist final `summary`/result text in a way that `get_subagent_status` can return `{ result }`.
   - Current `inspectSubagentStatus()` returns human text, not required object shape.
   - PLAN mentions persistence but must explicitly forbid deleting completion result before durable store is updated.

7. **Four-tool API needs more than schema changes.**
   - Current single `subagent` tool handles execution, management, status, interrupt/resume, doctor.
   - Four separate tool definitions require separate `ToolDefinition`s, separate schemas, renderers, and tests.
   - PLAN says register exactly four tools, but does not specify removing message renderers/bridges/slash surfaces that expose old orchestration behavior.

8. **Slash commands and prompt-template bridges remain old public surface.**
   - `index.ts` registers slash subagent bridge, prompt template bridge, and slash commands.
   - `src/slash/*` still exposes `/run`, `/chain`, `/parallel`, saved chains, template delegation.
   - Scope says four tools, no chain/parallel task-list mode, no agent types. PLAN should explicitly remove/disable slash command registration and prompt template bridges, not only root `prompts/`.

9. **Built-in `agents/` deletion is not enough.**
   - `discoverAgents()` also reads user/project agents and chains.
   - If any runtime path still calls discovery, agent types/AgentConfig remain through external files even after deleting vendored `agents/`.
   - PLAN should require no discovery at runtime for the four tools.

10. **Fork context currently adds extra behavioral task preamble.**
    - `wrapForkTask()` prepends `DEFAULT_FORK_PREAMBLE` for forked context.
    - Scope wants one automatic child system line only and unrestricted child behavior.
    - Even if this is task text rather than system prompt, it is automatic behavioral instruction. PLAN should say remove/disable this preamble for `keepContext: true`.

11. **`keepContext` semantics need precise implementation.**
    - Current `context: "fork"` uses `createForkContextResolver()` session files plus prompt/message filtering.
    - Scope wants inherit project context and skills always true, with no hidden context. PLAN must define `keepContext: true` as fork session without filtering or behavioral wrapper.

12. **Model/thinking/fallback behavior still coupled to agents.**
    - Current model path applies agent model, fallbackModels, thinking suffix, and current provider heuristics.
    - Scope only allows caller-supplied `model?`; no agent defaults.
    - PLAN should require removing fallback/thinking/default model use from subagent execution unless inherited Pi defaults handle it naturally.

13. **Intercom/steering plan over-promises current capability.**
    - Current live steering depends on intercom bridge being injected into an agent prompt/config.
    - Removing agent prompts/config likely removes that mechanism.
    - PLAN should either preserve a minimal additive runtime steering bridge or define `steer_subagent` as resume-after-stop plus best-effort live delivery with clear implementation files.

14. **Notifications need parent-session cohort state not present today.**
    - Current notifications are per result and know `taskIndex/totalTasks` only for old parallel batches.
    - Repeated async spawns need new parent-session group/cohort store.
    - PLAN describes algorithm but lacks durable schema/files and interaction with result watcher deletion/dedupe.

15. **List/status scoping is underspecified.**
    - Current status list defaults to queued/running only and is human-formatted.
    - Scope schema returns `Array<{id,running}>`; likely should include completed direct children for retrieval.
    - PLAN should define whether `list_subagents` lists all known direct children for current parent session or only running ones, and test it.

16. **Extension child runtime injection may suppress normal configured extensions.**
    - PLAN notes this nuance, but current `buildPiArgs()` also pushes `--no-extensions` whenever `extensions` is defined.
    - Once AgentConfig is removed this may be less likely, but tests must cover additive runtime extension plus normal extensions loaded.
    - Also current `PI_SUBAGENT_CHILD` guard conflicts with loading the real subagent extension in children.

17. **Root/package manifests must remove old surfaces in both places.**
    - Root `package.json` loads `extensions/pi-subagents/prompts`.
    - Vendored `package.json` `files` and `pi.prompts` include `prompts/`; description advertises chains/parallel/TUI.
    - PLAN mentions manifests but should explicitly cover both root and vendored package metadata.

18. **Existing tests are mostly old-behavior tests.**
    - Many current tests assert agents, frontmatter, slash, chain, parallel, template, prompt stripping, child registration behavior, and file-only output.
    - PLAN lists categories to delete/rewrite but misses several exact files likely to fail.

## Concrete PLAN.md edits needed

### Phase 1: Public API

- Add explicit requirement: delete/stop registering `subagent` tool and register four independent `ToolDefinition`s in `src/extension/index.ts`.
- Add exact schemas for:
  - `spawn_subagent`: required `task`, `async`, `keepContext`, `outputMode`; optional `cwd`, `model`; `additionalProperties: false` if TypeBox supports it.
  - `steer_subagent`: required `id`, `message`.
  - `get_subagent_status`: required `id`.
  - `list_subagents`: no params / empty object.
- Add requirement that removed fields are rejected, not silently ignored, if Pi schema validation supports it.
- Add return-shape requirement in `AgentToolResult.details` and human `content`, e.g. `details: { id, running, result?, error? }` for status.

### Phase 2: Runtime model

- Replace `ChildRunRequest` with a fuller concrete internal type:

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

- Add explicit task: remove `AgentConfig` from runtime execution, not just public API. Refactor `runSync()`/async runner to accept direct child specs.
- Add explicit task: no `discoverAgents()` calls in four-tool runtime path.

### Phase 3: Old surfaces

- Explicitly remove/disable:
  - `src/slash/*` registrations from `index.ts`
  - `registerPromptTemplateDelegationBridge()`
  - `registerSlashSubagentBridge()`
  - slash live-state renderers if no longer used
  - `doctor` management path and `src/extension/doctor.ts` if unused
  - TUI clarify code (`chain-clarify.ts`) if only for old modes
- Keep render helpers only if useful for four-tool display and not old semantics.

### Phase 4: Child Pi args

- Add explicit requirement: remove or change `if (process.env[SUBAGENT_CHILD_ENV] === "1") return;` so child Pi registers subagent tools until depth blocks spawn.
- Define replacement env, if needed, for prompt-runtime/session plumbing that does not disable extension registration.
- Add test: child env still registers four tools.
- Add test: max depth causes `spawn_subagent` error, not missing tool.

### Phase 5: Prompt runtime

- Replace current requirements with stricter ones:
  - Export `CHILD_SUBAGENT_SYSTEM_LINE` exactly.
  - Prepend only that line.
  - Delete/disable `stripProjectContext`, `stripInheritedSkills`, `stripSubagentOrchestrationSkill`, and assistant/tool-result stripping for forked context unless a specific non-context notification filter is proven harmless.
  - Do not read `PI_SUBAGENT_INHERIT_PROJECT_CONTEXT` or `PI_SUBAGENT_INHERIT_SKILLS`; inherited context/skills are always on.
- Add test that prompt containing project context, skill blocks, and subagent tool descriptions survives unchanged except one line prepended.

### Phase 6: Persistence

- Add dedicated store file/module, e.g. `src/runs/background/subagent-store.ts`, under existing temp root.
- Store result text/path in durable record before notification and never depend on transient `RESULTS_DIR/*.json` after watcher deletion.
- Change `result-watcher.ts`: either do not delete result JSON until store has copied full data, or write result directly into store from runner.
- Define parent-session scoping and completed retention/cleanup.

### Phase 7: Async notifications

- Add durable parent-session cohort store fields:
  - active async child IDs
  - completed-not-final-announced child IDs
  - final-announced marker
- Require notification text to include child ID and exact instruction shape: `Call get_subagent_status({ id: "..." })`.
- Require partial notification text to contain `N out of M subagents have completed` and all-complete promise.
- Require all-complete notification to list IDs or instruct fetching each ID.

### Phase 8: Steering

- Decide implementation after removing agent intercom bridge:
  - Option A: keep/add minimal runtime extension/intercom channel independent of agent config for live child messages.
  - Option B: implement queued message + resume only, and document live steering as best-effort if existing session accepts it.
- Add durable pending steering messages to store.
- Add tests for running-child acknowledgement and stopped-child resume path.

### Phase 9: Output modes

- Rename internal type to `"inline" | "file"` or add boundary conversion only at old helper calls.
- Define default file output path, e.g. under async/child artifact dir: `<runtime>/<parentSession>/<id>/result.md`.
- Remove public `output` param from docs/tests.
- For `outputMode: "file"`, return/store file path only; for `inline`, return/store raw result.

### Phase 10: Recursion depth

- Keep depth env helpers, but remove agent-specific depth min (`resolveChildMaxSubagentDepth(parent, agentMaxDepth)`) because no agent max depth exists.
- Test depth decrement/increment across recursive spawn.

### Phase 11: Docs/manifests

- Explicitly update both:
  - root `package.json` `pi.prompts`
  - `extensions/pi-subagents/package.json` `files`, `pi.prompts`, description
- Rewrite `skills/pi-subagents/SKILL.md`; current file is entirely old orchestrator/agent/chain guidance and tells children not to spawn subagents.
- Rewrite README from scratch or heavily prune; current docs are mostly invalid.

### Phase 12: Tests

Add exact obsolete test file list to delete/rewrite:

- `test/unit/agent-disabled.test.ts`
- `test/unit/agent-frontmatter.test.ts`
- `test/unit/agent-management.test.ts`
- `test/unit/agent-overrides.test.ts`
- `test/unit/agent-scope.test.ts`
- `test/unit/agent-selection.test.ts`
- `test/unit/chain-serializer.test.ts`
- `test/unit/prompt-template-bridge.test.ts`
- `test/unit/skills-fallback.test.ts` if only agent-skill fallback
- `test/unit/tool-description.test.ts`
- `test/unit/types-fork-preamble.test.ts`
- `test/integration/chain-clarify.test.ts`
- `test/integration/chain-execution.test.ts`
- `test/integration/parallel-execution.test.ts`
- `test/integration/slash-commands.test.ts`
- `test/integration/slash-live-state.test.ts`
- `test/integration/template-resolution.test.ts`

Add missing new tests:

- child env registers all four tools
- runtime prompt preserves project context, skills, extension/tool descriptions
- `outputMode: "file"` with no output param creates result file and returns path
- result remains retrievable after result watcher processes completion
- `list_subagents` includes completed known children if that is desired behavior
- old slash commands unavailable or not registered
- no `agents/` or `prompts/` package manifest references

## Files needing attention

### Must change for scope

- `extensions/pi-subagents/src/extension/index.ts`
- `extensions/pi-subagents/src/extension/schemas.ts`
- `extensions/pi-subagents/src/runs/foreground/subagent-executor.ts`
- `extensions/pi-subagents/src/runs/foreground/execution.ts`
- `extensions/pi-subagents/src/runs/background/async-execution.ts`
- `extensions/pi-subagents/src/runs/background/subagent-runner.ts`
- `extensions/pi-subagents/src/runs/background/result-watcher.ts`
- `extensions/pi-subagents/src/runs/background/notify.ts`
- `extensions/pi-subagents/src/runs/background/run-status.ts`
- `extensions/pi-subagents/src/runs/background/async-status.ts`
- `extensions/pi-subagents/src/runs/background/async-resume.ts`
- `extensions/pi-subagents/src/runs/shared/pi-args.ts`
- `extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts`
- `extensions/pi-subagents/src/runs/shared/parallel-utils.ts` or replacement runner types
- `extensions/pi-subagents/src/shared/types.ts`
- `extensions/pi-subagents/src/shared/utils.ts` if status/result helpers remain old-shaped
- `extensions/pi-subagents/src/shared/fork-context.ts`
- `extensions/pi-subagents/src/runs/shared/single-output.ts`

### Should delete or remove from runtime graph

- `extensions/pi-subagents/agents/`
- `extensions/pi-subagents/prompts/`
- `extensions/pi-subagents/src/agents/` except possibly `skills.ts` if reused without AgentConfig semantics
- `extensions/pi-subagents/src/slash/`
- `extensions/pi-subagents/src/runs/foreground/chain-execution.ts`
- `extensions/pi-subagents/src/runs/foreground/chain-clarify.ts`
- `extensions/pi-subagents/src/runs/background/parallel-groups.ts` if only old chain/parallel status
- `extensions/pi-subagents/src/extension/doctor.ts`
- chain/agent-specific pieces of `extensions/pi-subagents/src/shared/settings.ts`

### Docs/manifests

- `package.json`
- `extensions/pi-subagents/package.json`
- `extensions/pi-subagents/README.md`
- `extensions/pi-subagents/skills/pi-subagents/SKILL.md`
- `extensions/pi-subagents/CHANGELOG.md` if package docs/tests expect consistency

## Scope conflicts in PLAN.md

1. **“Preserve ... fork-context support” conflicts unless filtering/preamble removed.** Current fork support strips messages and adds a preamble. Preserve only session forking, not behavior filtering.

2. **“Preserve ... status files” conflicts with required status API if result JSON is deleted.** Preserve status infrastructure, but add durable result fields/store.

3. **“Internal result records may keep a field named agent” is safe only if it cannot affect model/prompt/tools.** Current `agent` fields do affect lookup throughout runtime. PLAN must require decoupling before allowing compatibility fields.

4. **“Map outputMode:file to existing file-output machinery” is incomplete because existing machinery expects a separate output path and uses `file-only`, not `file`.

5. **“Runtime extension injection for one-line system prompt and status/session support” may conflict with normal extension inheritance if passed via `--extension` in a restrictive way.** Must be tested against actual Pi CLI semantics.

6. **“Completion notifications queued to parent” conflicts with current result watcher deleting files after notification.** Retrieval instruction is bad unless durable status/result exists first.

7. **Keeping slash/prompt-template bridges conflicts with four tools only/no chain/no parallel task-list/no agent types.** PLAN should explicitly remove them, not just old tool schema/docs.
