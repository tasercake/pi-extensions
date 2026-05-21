# Steering Removal Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Remove all product-facing steering/follow-up support from `pi-subagents` while preserving spawn/status/list behavior exactly as scoped in `STEERING_REMOVAL_SCOPE.md`.

**Architecture:** Delete the `steer_subagent` tool registration and schema/type surface. Keep persisted run records, process tracking, async notifications, result extraction, and status/list flows unchanged except for removing steering-only file writes, signals, and resume behavior. Update package docs/tests so the only model-visible tools are `spawn_subagent`, `get_subagent_status`, and `list_subagents`.

**Tech Stack:** TypeScript ESM extension code, `typebox` schemas, Node built-in test runner, Pi extension `ToolDefinition` API.

---

## Immutable Scope Guardrails

- Do not edit `extensions/pi-subagents/STEERING_REMOVAL_SCOPE.md`.
- Do not add a replacement follow-up, resume, interrupt, pause, queue, acknowledgement, chat, or orchestration feature.
- Do not change `spawn_subagent`, `get_subagent_status`, or `list_subagents` user-facing behavior except to remove references to steering.
- Do not remove internal `runningChildren` tracking if it is still useful for lifecycle cleanup or future non-user-facing bookkeeping; only remove steering-driven signal/resume behavior.
- Do not preserve compatibility by keeping a hidden/no-op `steer_subagent`; success requires no model-visible steering tool.

## Current Steering Surface To Remove

- `extensions/pi-subagents/src/extension/schemas.ts`
  - `SteerSubagentParams`
  - `SteerSubagentParamsLike`
- `extensions/pi-subagents/src/extension/index.ts`
  - imports of `SteerSubagentParams` and `SteerSubagentParamsLike`
  - `steerTool` definition
  - `pi.registerTool(steerTool)`
  - steering behavior that writes `steering.md`, sends `SIGUSR2`, and starts a follow-up `runChild(...)`
- `extensions/pi-subagents/test/unit/minimal-subagents.test.ts`
  - import and assertions for `SteerSubagentParams`
  - test name currently claiming “four-tool” shape
- `extensions/pi-subagents/README.md`
  - `steer_subagent` tool section
  - “four tools” wording if present or introduced elsewhere
- `extensions/pi-subagents/skills/pi-subagents/SKILL.md`
  - `steer_subagent` entry in the tool list
- `extensions/pi-subagents/package.json`
  - description currently says “four tools”
  - `bin` points at `install.mjs`
  - `files` packages `*.mjs`, so `install.mjs` is a shipped user-facing surface
  - `files` currently packages `CHANGELOG.md`, which contains historical user-facing wording that can be misread as steering/follow-up support
- `extensions/pi-subagents/install.mjs`
  - post-install output currently lists `steer_subagent`
  - post-install output currently says “follow-up”
- `extensions/pi-subagents/CHANGELOG.md`
  - do not ship in this package unless its user-facing removed-interaction wording is rewritten or explicitly excluded by packaging

---

## Task 1: Update Schema Unit Test To Expect Three Tools

**Objective:** Establish failing coverage that the schema module no longer exports a steering parameter schema and that the supported tool set is spawn/status/list only.

**Files:**

- Modify: `extensions/pi-subagents/test/unit/minimal-subagents.test.ts`

**Step 1: Edit imports**

Replace:

```ts
import {
  SpawnSubagentParams,
  SteerSubagentParams,
  GetSubagentStatusParams,
  ListSubagentsParams,
} from "../../src/extension/schemas.ts";
```

with:

```ts
import {
  SpawnSubagentParams,
  GetSubagentStatusParams,
  ListSubagentsParams,
} from "../../src/extension/schemas.ts";
```

**Step 2: Rename and tighten schema test**

Replace test name and body:

```ts
test("schemas expose minimal four-tool parameter shapes", () => {
  assert.equal(SpawnSubagentParams.additionalProperties, false);
  assert.deepEqual(
    Object.keys(SpawnSubagentParams.properties).sort(),
    ["async", "cwd", "keepContext", "model", "outputMode", "task"].sort(),
  );
  assert.equal(SteerSubagentParams.additionalProperties, false);
  assert.deepEqual(Object.keys(SteerSubagentParams.properties).sort(), [
    "id",
    "message",
  ]);
  assert.equal(GetSubagentStatusParams.additionalProperties, false);
  assert.deepEqual(Object.keys(GetSubagentStatusParams.properties), ["id"]);
  assert.equal(ListSubagentsParams.additionalProperties, false);
  assert.deepEqual(Object.keys(ListSubagentsParams.properties), []);
});
```

with:

```ts
test("schemas expose minimal three-tool parameter shapes", async () => {
  assert.equal(SpawnSubagentParams.additionalProperties, false);
  assert.deepEqual(
    Object.keys(SpawnSubagentParams.properties).sort(),
    ["async", "cwd", "keepContext", "model", "outputMode", "task"].sort(),
  );
  assert.equal(GetSubagentStatusParams.additionalProperties, false);
  assert.deepEqual(Object.keys(GetSubagentStatusParams.properties), ["id"]);
  assert.equal(ListSubagentsParams.additionalProperties, false);
  assert.deepEqual(Object.keys(ListSubagentsParams.properties), []);

  const schemas = await import("../../src/extension/schemas.ts");
  assert.equal("SteerSubagentParams" in schemas, false);
});
```

**Step 3: Run focused test and verify failure**

Run from `extensions/pi-subagents`:

```bash
npm run test:unit -- --test-name-pattern='schemas expose minimal three-tool parameter shapes'
```

Expected before implementation: FAIL because `SteerSubagentParams` still exists.

---

## Task 2: Remove Steering Schema And Type Exports

**Objective:** Remove model-visible steering schema definitions from the extension schema module.

**Files:**

- Modify: `extensions/pi-subagents/src/extension/schemas.ts`

**Step 1: Delete steering schema export**

Remove exactly:

```ts
export const SteerSubagentParams = Type.Object(
  {
    id: Type.String({ description: "Subagent id returned by spawn_subagent." }),
    message: Type.String({
      description: "Follow-up instruction for the child Pi.",
    }),
  },
  { additionalProperties: false },
);
```

**Step 2: Delete steering interface export**

Remove exactly:

```ts
export interface SteerSubagentParamsLike {
  id: string;
  message: string;
}
```

**Step 3: Run focused test**

Run from `extensions/pi-subagents`:

```bash
npm run test:unit -- --test-name-pattern='schemas expose minimal three-tool parameter shapes'
```

Expected: PASS.

---

## Task 3: Add Extension Registration Test For Exact Tool Names

**Objective:** Prove the Pi extension registers only `spawn_subagent`, `get_subagent_status`, and `list_subagents`.

**Files:**

- Modify: `extensions/pi-subagents/test/unit/minimal-subagents.test.ts`

**Step 1: Add imports**

Add near existing imports:

```ts
import registerSubagentExtension from "../../src/extension/index.ts";
```

**Step 2: Add fake Pi registration test**

Append this test after the schema test:

```ts
test("extension registers only spawn status and list tools", () => {
  const registered: Array<{ name: string }> = [];
  const fakePi = {
    registerTool(tool: { name: string }) {
      registered.push(tool);
    },
    sendMessage() {
      throw new Error("sendMessage should not be called during registration");
    },
  };

  registerSubagentExtension(fakePi as never);

  assert.deepEqual(
    registered.map((tool) => tool.name),
    ["spawn_subagent", "get_subagent_status", "list_subagents"],
  );
  assert.equal(
    registered.some((tool) => tool.name === "steer_subagent"),
    false,
  );
});
```

Keep import list minimal; registration does not need context.

**Step 3: Run focused test and verify failure**

Run from `extensions/pi-subagents`:

```bash
npm run test:unit -- --test-name-pattern='extension registers only spawn status and list tools'
```

Expected at this point after Task 2: FAIL because `src/extension/index.ts` still imports the deleted steering schema. This is the intended intermediate failure; do not chase it separately. If this test is run before Task 2, it fails because `steer_subagent` is still registered between spawn and status. Task 4 fixes both the stale import and the registration surface.

---

## Task 4: Remove Steering Tool From Extension Registration

**Objective:** Stop presenting any steering tool to the model and remove all steering behavior paths.

**Files:**

- Modify: `extensions/pi-subagents/src/extension/index.ts`

**Step 1: Remove steering imports**

Change schema import block from:

```ts
import {
  GetSubagentStatusParams,
  ListSubagentsParams,
  SpawnSubagentParams,
  SteerSubagentParams,
  type GetSubagentStatusParamsLike,
  type SpawnSubagentParamsLike,
  type SteerSubagentParamsLike,
} from "./schemas.ts";
```

to:

```ts
import {
  GetSubagentStatusParams,
  ListSubagentsParams,
  SpawnSubagentParams,
  type GetSubagentStatusParamsLike,
  type SpawnSubagentParamsLike,
} from "./schemas.ts";
```

**Step 2: Delete the full `steerTool` definition**

Remove the entire block beginning with:

```ts
	const steerTool: ToolDefinition<typeof SteerSubagentParams, ToolDetails> = {
```

and ending immediately before:

```ts
	const statusTool: ToolDefinition<
```

This deletion removes:

- writing `steering.md`
- appending follow-up messages
- sending `SIGUSR2` to running children
- starting follow-up `runChild(...)` for completed children
- steering render text

**Step 3: Remove steering registration**

Delete:

```ts
pi.registerTool(steerTool);
```

Final registration order must be:

```ts
pi.registerTool(spawnTool);
pi.registerTool(statusTool);
pi.registerTool(listTool);
```

**Step 4: Run focused registration test**

Run from `extensions/pi-subagents`:

```bash
npm run test:unit -- --test-name-pattern='extension registers only spawn status and list tools'
```

Expected: PASS.

**Behavioral result:**

- Running children continue their original process until completion/failure.
- Completed children remain final and inspectable by status.
- Parent can no longer send follow-up instructions through the extension.
- No `steering.md` file is created by extension behavior.
- No `SIGUSR2` is sent to child Pi processes by extension behavior.

---

## Task 5: Add Regression Test That Completed Children Are Final By API Absence

**Objective:** Assert the supported API has no steering/follow-up entrypoint after a child completes.

**Files:**

- Modify: `extensions/pi-subagents/test/unit/minimal-subagents.test.ts`

**Step 1: Add assertion to registration test**

Extend the existing registration test with:

```ts
const toolNames = new Set(registered.map((tool) => tool.name));
assert.equal(toolNames.has("steer_subagent"), false);
assert.equal(toolNames.has("resume_subagent"), false);
assert.equal(toolNames.has("follow_up_subagent"), false);
assert.equal(toolNames.has("interrupt_subagent"), false);
```

Place it after the `assert.deepEqual(...)` block.

**Step 2: Run focused test**

Run from `extensions/pi-subagents`:

```bash
npm run test:unit -- --test-name-pattern='extension registers only spawn status and list tools'
```

Expected: PASS after Task 4.

**Note:** Do not add a no-op tool that returns “unsupported”; the scope requires no model-visible steering tool.

---

## Task 6: Update README User-Facing Tool Surface

**Objective:** Remove steering documentation from package README and make spawn/status/list the only documented tools.

**Files:**

- Modify: `extensions/pi-subagents/README.md`

**Step 1: Remove steering section**

Delete this section completely:

````md
### `steer_subagent`

```ts
steer_subagent({ id: string, message: string });
```

Queues a message for a running subagent or resumes a stopped subagent with the message.
````

Be careful with nested markdown fences when editing: remove the heading, TypeScript example, and explanatory sentence only.

**Step 2: Keep documented tools in order**

The `## Tools` section must document only:

1. `spawn_subagent`
2. `get_subagent_status`
3. `list_subagents`

**Step 3: Add explicit finality note under `get_subagent_status` or after `list_subagents`**

Add this short note after the `list_subagents` section:

```md
Completed children are final. Running children continue their original task until completion or failure. The extension exposes only spawn, status, and list tools.
```

**Step 4: Verify docs contain no steering tool mention**

Run from `extensions/pi-subagents`:

```bash
rg -n 'steer_subagent|Queues a message|resumes a stopped|steering|follow-up|pause|resume|interrupt' README.md
```

Expected: no matches.

---

## Task 7: Update Bundled Skill Tool Surface

**Objective:** Ensure the model-facing bundled skill does not teach or mention steering.

**Files:**

- Modify: `extensions/pi-subagents/skills/pi-subagents/SKILL.md`

**Step 1: Remove steering bullet**

Change:

```md
- `spawn_subagent({ task, async, keepContext, cwd?, outputMode, model? })`
- `steer_subagent({ id, message })`
- `get_subagent_status({ id })`
- `list_subagents({})`
```

to:

```md
- `spawn_subagent({ task, async, keepContext, cwd?, outputMode, model? })`
- `get_subagent_status({ id })`
- `list_subagents({})`
```

**Step 2: Add exact-tool-surface rule**

In `## Rules`, add:

```md
- Available subagent tools are exactly the three listed above.
```

Do not add replacement workflow recipes or terminology for removed interactive behavior.

**Step 3: Verify skill contains no removed API wording**

Run from `extensions/pi-subagents`:

```bash
rg -n 'steer_subagent|steering|follow-up|message queue|message-queue|pause|resume|interrupt|replacement' skills/pi-subagents/SKILL.md
```

Expected: no matches.

---

## Task 8: Update Package Metadata, Installer Output, And Exclude Historical Changelog From Published Package

**Objective:** Align package metadata and installer output with the three-tool product surface and ensure packaged artifacts do not ship historical changelog wording that can be read as steering/follow-up support.

**Files:**

- Modify: `extensions/pi-subagents/package.json`
- Modify: `extensions/pi-subagents/install.mjs`

**Step 1: Update package description**

Change in `package.json`:

```json
"description": "Minimal recursive Pi child-subagent spawner with four tools",
```

to:

```json
"description": "Minimal recursive Pi child-subagent spawner with spawn, status, and list tools",
```

Do not change version in this plan unless release owner explicitly asks during rollout.

**Step 2: Remove `CHANGELOG.md` from packaged files**

Change the `files` array from:

```json
"files": [
  "src/**/*.ts",
  "*.mjs",
  "skills/**/*",
  "README.md",
  "CHANGELOG.md"
],
```

to:

```json
"files": [
  "src/**/*.ts",
  "*.mjs",
  "skills/**/*",
  "README.md"
],
```

Rationale: `CHANGELOG.md` contains historical user-facing wording such as follow-up subagent runs, steer wording, resume wording, and interrupt wording from broader package history. This removal prevents old interaction semantics from shipping in the npm package without rewriting unrelated historical release notes. Do not edit `STEERING_REMOVAL_SCOPE.md`.

**Step 3: Update installer post-install output**

Change the final install message from:

```js
console.log(`
The extension is now available in pi. Tools added:
  • spawn_subagent - Spawn one child Pi task (blocking or async)
  • steer_subagent - Send a follow-up message to a child
  • get_subagent_status - Retrieve child status/result
  • list_subagents - List persisted children for this session

Documentation: ${EXTENSION_DIR}/README.md
`);
```

to:

```js
console.log(`
The extension is now available in pi. Tools added:
  • spawn_subagent - Spawn one child Pi task (blocking or async)
  • get_subagent_status - Retrieve child status/result
  • list_subagents - List persisted children for this session

Documentation: ${EXTENSION_DIR}/README.md
`);
```

Do not replace this with any alternate follow-up, steering, resume, pause, interrupt, or message-queue wording. `install.mjs` is packaged via `*.mjs` and exposed as the package `bin`, so treat it as a user-facing shipped surface.

**Step 4: Verify package metadata and installer output**

Run from `extensions/pi-subagents`:

```bash
node -e "const p=require('./package.json'); if(/four tools|steer/i.test(p.description)) process.exit(1); if((p.files||[]).includes('CHANGELOG.md')) process.exit(2); console.log(p.description)"
rg -n 'steer_subagent|steering|follow-up|message queue|message-queue|pause|resume|interrupt|four tools' install.mjs package.json
```

Expected output from the `node` command:

```text
Minimal recursive Pi child-subagent spawner with spawn, status, and list tools
```

Expected output from `rg`: no matches.

---

## Task 9: Add Repository-Wide No-Steering Visibility Test

**Objective:** Catch future reintroduction of user-facing steering docs or tool names.

**Files:**

- Modify: `extensions/pi-subagents/test/unit/minimal-subagents.test.ts`

**Step 1: Add filesystem imports if not already present**

Add near imports:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
```

**Step 2: Add project root helper**

Add after imports:

```ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
```

If `__dirname` already exists in this test file after future edits, reuse it instead of duplicating.

**Step 3: Add no user-facing steering references test**

Append:

```ts
test("user-facing packaged docs do not expose removed API concepts", () => {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJsonText = fs.readFileSync(packageJsonPath, "utf-8");
  const packageJson = JSON.parse(packageJsonText) as { files?: string[] };

  assert.equal(
    (packageJson.files ?? []).includes("CHANGELOG.md"),
    false,
    "CHANGELOG.md must not be packaged unless removed-interaction wording is rewritten and covered by this test",
  );

  const files = [
    "README.md",
    "skills/pi-subagents/SKILL.md",
    "package.json",
    "install.mjs",
  ];
  const forbidden = [
    "steer_subagent",
    "steering",
    "follow-up",
    "message queue",
    "message-queue",
    "Queues a message for a running subagent",
    "resumes a stopped subagent",
    "replacement",
  ];

  for (const relativePath of files) {
    const text = fs
      .readFileSync(path.join(projectRoot, relativePath), "utf-8")
      .toLowerCase();
    for (const term of forbidden) {
      assert.equal(
        text.includes(term.toLowerCase()),
        false,
        `${relativePath} mentions ${term}`,
      );
    }
  }
});
```

This test intentionally checks only user-facing model/package docs, package metadata, and the packaged installer executable, not planning or review artifacts.

**Step 4: Run focused docs test**

Run from `extensions/pi-subagents`:

```bash
npm run test:unit -- --test-name-pattern='user-facing packaged docs do not expose removed API concepts'
```

Expected after Tasks 6-8: PASS. If future release owners decide to keep packaging `CHANGELOG.md`, update this test to include `CHANGELOG.md` in `files` after rewriting or narrowly qualifying all removed-interaction wording so shipped changelog text cannot be read as current steering/follow-up support. Keep `install.mjs` in this file list because `package.json.files` includes `*.mjs` and `package.json.bin` exposes it.

---

## Task 10: Full Validation Pass

**Objective:** Verify all unit tests pass and no steering tool remains in source/docs surfaces that feed the model.

**Files:**

- No source changes unless validation finds failures.

**Step 1: Run unit tests**

Run from `extensions/pi-subagents`:

```bash
npm run test:unit
```

Expected: all tests pass.

**Step 2: Run package test alias**

Run from `extensions/pi-subagents`:

```bash
npm test
```

Expected: same unit test suite passes.

**Step 3: Run TypeScript syntax/import smoke test through existing test runner**

Run from `extensions/pi-subagents`:

```bash
node --experimental-strip-types --test test/unit/*.test.ts
```

Expected: all tests pass; no missing export/import errors for `SteerSubagentParams`.

**Step 4: Search for remaining steering tool identifiers**

Run from `extensions/pi-subagents`:

```bash
rg -n 'SteerSubagentParams|SteerSubagentParamsLike|steerTool|steering\.md|SIGUSR2|Queued steering|Resumed subagent|follow-up from parent' src README.md skills package.json install.mjs
```

Expected: no matches.

**Step 5: Search all package-controlled shipped surfaces before packing**

Run from `extensions/pi-subagents`:

```bash
rg -n 'steer_subagent|SteerSubagent|steering message|resumes a stopped subagent|follow-up|message queue|message-queue|four tools' src README.md skills package.json install.mjs --glob '!package-lock.json' --glob '!node_modules/**'
node -e "const p=require('./package.json'); if((p.files||[]).includes('CHANGELOG.md')) { console.error('CHANGELOG.md is still packaged'); process.exit(1); }"
```

Expected: no `rg` matches, and `CHANGELOG.md` is not in `package.json.files`. If `CHANGELOG.md` is intentionally re-added later, first rewrite or explicitly qualify historical removed-interaction wording, then add it to the forbidden-term scan.

**Step 6: Inspect actual packed file list and packed content**

Run from `extensions/pi-subagents`:

```bash
set -euo pipefail
PACK_TGZ=$(npm pack --json | node -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => console.log(JSON.parse(s)[0].filename));")
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR" "$PACK_TGZ"' EXIT

tar -tf "$PACK_TGZ" | tee "$TMP_DIR/files.txt"
! grep -Fx 'package/CHANGELOG.md' "$TMP_DIR/files.txt"
grep -Fx 'package/README.md' "$TMP_DIR/files.txt"
grep -Fx 'package/package.json' "$TMP_DIR/files.txt"
grep -Fx 'package/install.mjs' "$TMP_DIR/files.txt"
grep -q '^package/src/' "$TMP_DIR/files.txt"
grep -q '^package/skills/' "$TMP_DIR/files.txt"

tar -xzf "$PACK_TGZ" -C "$TMP_DIR"
! rg -n 'steer_subagent|SteerSubagent|steering message|resumes a stopped subagent|follow-up|message queue|message-queue|four tools|Queued steering|Resumed subagent|follow-up from parent' "$TMP_DIR/package"
```

Expected: file list includes `src/**/*.ts`, `skills/**/*`, `README.md`, `install.mjs`, and `package.json`; file list excludes `package/CHANGELOG.md`; final `rg` command returns no matches. If the final `rg` prints matches, removed interaction semantics would ship and the implementation is not acceptable.

---

## Rollout And Compatibility Notes

- This is a breaking API surface reduction for callers that used `steer_subagent`.
- Do not provide a shim, alias, no-op, or hidden tool: the scope requires no model-visible steering command.
- Existing persisted subagent records remain readable because record shape does not need migration; status/list only read run metadata and result files.
- Existing `steering.md` files from older versions, if present under `~/.pi/agent/subagents-minimal/...`, become inert leftover files. Do not read, migrate, or delete them in implementation; deleting user data is unnecessary for this scope.
- Running children launched before upgrade keep running as normal OS child processes only if the parent process still owns them. New extension code will not send steering signals or append queue files.
- Parent-agent docs must stay limited to spawn/status/list primitives; do not add interactive workflow guidance.
- No version bump is included in implementation tasks. Release owner can bump version separately according to package release process.

## Final Acceptance Checklist

- [ ] `src/extension/index.ts` registers exactly three tools: `spawn_subagent`, `get_subagent_status`, `list_subagents`.
- [ ] `src/extension/schemas.ts` exports no steering schema or steering params interface.
- [ ] No extension path writes `steering.md`.
- [ ] No extension path sends `SIGUSR2` for child steering.
- [ ] No extension path resumes completed children with follow-up text.
- [ ] `README.md` documents only spawn/status/list.
- [ ] `skills/pi-subagents/SKILL.md` documents only spawn/status/list and contains no removed API wording.
- [ ] `package.json` description no longer says “four tools”.
- [ ] `install.mjs` lists only spawn/status/list and contains no removed interaction wording.
- [ ] `package.json.files` no longer includes `CHANGELOG.md`, so historical changelog wording is not shipped.
- [ ] `npm run test:unit` passes from `extensions/pi-subagents`.
- [ ] `rg` validation commands above find no forbidden removed-API identifiers in source, package metadata, README, or bundled skill docs.
- [ ] Actual `npm pack` tarball inspection confirms packaged contents exclude `CHANGELOG.md` and contain no removed steering/follow-up semantics.
