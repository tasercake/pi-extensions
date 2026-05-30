# Subagent Auto-Result-File — Implementation Plan

## Implementation Plan

### Architecture Overview

The subagent system currently supports two result modes (`inline` and `file`) via the `outputMode` parameter. This plan removes `outputMode` and makes `file` the only mode. Every subagent always writes its result to `<parentSessionDir>/subagents/<subagentId>/result.md`. The result path is shared with the parent at spawn time and in the completion notification. The subagent is informed of its result path via injected prompt so it may write to it programmatically. At exit, if the file is empty/absent, the subagent's final assistant message is extracted from stdout and auto-written to the result file. The parent consumes results using the standard `read` tool — no specialized tool call needed.

The implementation touches four files:
1. **`schemas.ts`** — Remove `outputMode` from `SpawnSubagentParams` and `SpawnSubagentParamsLike`
2. **`index.ts`** (extension) — Remove `outputMode` from `PersistedSubagentRecord`, eliminate inline result paths, update spawn response to include `resultPath`, update completion notification to include `resultPath` without `get_subagent_status` instruction, update `runChild` to always write result file path
3. **`subagent-prompt-runtime.ts`** — Inject result file path into the subagent's system prompt
4. **`pi-args.ts`** — Pass result path env var to child process

---

## Reference: Existing Function `extractFinalOutput`

This function already exists in `index.ts`. It is called by `refreshRecordFromDisk` and `runChild`. Its behavior:

```ts
function extractFinalOutput(stdout: string): string {
  const rawLines: string[] = [];
  let lastAssistant = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown; errorMessage?: string };
      };
      if (event.message?.role === "assistant") {
        const text = extractTextFromMessageContent(event.message.content);
        if (text.trim()) lastAssistant = text.trim();
      }
    } catch {
      rawLines.push(line);
    }
  }
  return lastAssistant || rawLines.join("\n").trim();
}
```

- It parses the JSONL stdout line by line.
- It finds the **last** `assistant` message and returns its text content.
- If no assistant message is found, it falls back to non-JSON raw lines.
- If stdout is empty or contains no parseable content, it returns `""` (empty string).

---

### File-by-File Implementation

---

#### **`extensions/pi-subagents/src/extension/schemas.ts`**

**Changes:**
- Remove `outputMode` property from `SpawnSubagentParams`.
- Remove `outputMode` property from `SpawnSubagentParamsLike`.
- The `renderCall` function on `spawn_subagent` tool (in `index.ts`) must also strip `outputMode` from display.

**Trace to scope:**
- Requirement 1: Remove `outputMode` parameter.
- Constraints: TypeBox schema must be updated.

**Edge cases:**
- No backward compatibility needed (per Non-Goals).
- Existing tests that pass `outputMode: 'inline'` must remove that field (see Test Updates section).

---

#### **`extensions/pi-subagents/src/extension/index.ts`**

This is the largest change. Every function touching `outputMode` must be updated.

##### 2a. Remove `OutputMode` type alias (line ~39)

Delete:
```ts
type OutputMode = "inline" | "file";
```

##### 2b. Remove `outputMode` from `PersistedSubagentRecord` interface (line ~48)

Delete the `outputMode: OutputMode;` field.

##### 2c. Remove `outputMode` from `makeRecord` function

`makeRecord` currently sets `outputMode: params.outputMode`. Delete that line. The function already sets `outputFile: path.join(dir, "result.md")` — this stays. No other changes needed.

**Note for Test 7:** `makeRecord` calls `fs.mkdirSync(dir, { recursive: true })` which is idempotent — it does not delete or overwrite an existing directory or its contents. Pre-creating the child directory (and a `result.md` inside it) before a spawn call will not be clobbered by `makeRecord`.

##### 2d. Rewrite `refreshRecordFromDisk`

Current behavior (inline mode): stores `record.result = finalOutput`.
Current behavior (file mode): writes `finalOutput` to `record.outputFile`, sets `record.result = record.outputFile`. When only stderr content exists with no stdout output, sets `record.error` but writes **nothing** to the file — leaving `record.result` pointing to a nonexistent path.

New behavior (always file mode, three-way branch in `!hasExistingResult`):
1. Check if `record.outputFile` exists and has non-empty content. If yes, that content IS the result — do NOT overwrite it. Set `record.result = record.outputFile`.
2. If `record.outputFile` is absent or empty: call `extractFinalOutput(stdout)`.
   a. If it returns a non-empty string → write it to `record.outputFile`.
   b. Else if stderr has content → set `record.error` (if not already set), write `"(error)"` placeholder to `record.outputFile`.
   c. Else (no stdout, no stderr) → write `"(no output)"` placeholder to `record.outputFile`.
3. Set `record.result = record.outputFile`.

**The result file is ALWAYS written.** After `refreshRecordFromDisk` returns, `record.result` points to a file that exists and contains content in every case.

```ts
function refreshRecordFromDisk(
  record: PersistedSubagentRecord,
): PersistedSubagentRecord {
  if (record.running && !isPidRunning(record.pid)) {
    const stdout = fs.existsSync(record.stdoutFile)
      ? fs.readFileSync(record.stdoutFile, "utf-8")
      : "";
    const stderr = fs.existsSync(record.stderrFile)
      ? fs.readFileSync(record.stderrFile, "utf-8")
      : "";
    record.running = false;
    record.updatedAt = Date.now();
    record.completedAt ??= Date.now();

    // Check if subagent already wrote to the result file.
    const hasExistingResult =
      record.outputFile &&
      fs.existsSync(record.outputFile) &&
      fs.readFileSync(record.outputFile, "utf-8").trim().length > 0;

    if (!hasExistingResult) {
      const finalOutput = extractFinalOutput(stdout);
      if (finalOutput && record.outputFile) {
        fs.writeFileSync(record.outputFile, `${finalOutput}\n`, { mode: 0o600 });
      } else if (stderr.trim()) {
        // Subagent produced only stderr, no stdout output.
        if (!record.error) record.error = stderr.trim();
        if (record.outputFile) {
          fs.writeFileSync(record.outputFile, "(error)\n", { mode: 0o600 });
        }
      } else if (record.outputFile) {
        // Edge case: neither stdout nor stderr produced content.
        // Write a placeholder so the parent gets a valid result file.
        fs.writeFileSync(record.outputFile, "(no output)\n", { mode: 0o600 });
      }
    }
    // If hasExistingResult is true, the subagent already wrote its result.
    // Do NOT overwrite. Do NOT set record.error from stderr (stderr may be
    // harmless warnings — the subagent succeeded in writing its result file).
    record.result = record.outputFile;
    upsertRecord(record);
  }
  return record;
}
```

**Design rationale — three-way branch ensures result file always exists:**
| Condition | Result file | `record.error` |
|---|---|---|
| Subagent wrote result file | Preserved as-is | Not set (subagent succeeded) |
| stdout has output, no existing file | stdout output written | Not set |
| stderr only, no stdout, no existing file | `"(error)"` written | Set to stderr content |
| No stdout, no stderr, no existing file | `"(no output)"` written | Not set |

##### 2e. Simplify `resultForRecord`

Always return `record.outputFile`:
```ts
function resultForRecord(record: PersistedSubagentRecord): string | undefined {
  return record.outputFile;
}
```

##### 2f. Update `formatStatus` — rename `result` field to `resultPath`

The `content` JSON text block and `details` object currently use the field name `result`. Change it to `resultPath` since the value is always a file path now. **Do NOT remove `doNotPollNotice`.** The `doNotPollNotice` is part of `get_subagent_status` responses (Requirement 7 says `get_subagent_status` "must continue to report the subagent's running state"), and a polite do-not-poll reminder when the subagent is still running is compatible with that requirement. The scope's Requirement 3 (completion notification must not instruct parent to call `get_subagent_status`) only applies to the **completion notification** (see 2g), not to `formatStatus`.

The existing `doNotPollNotice` text — *"Do not poll for the result. You will be notified when the subagent completes."* — remains accurate and appropriate.

Current `formatStatus` JSON fields (relevant parts):
```ts
{ id, running, ...(result ? { result } : {}), ...(refreshed.error ? { error } : {}) }
```

Changed to:
```ts
{ id, running, ...(result ? { resultPath: result } : {}), ...(refreshed.error ? { error } : {}) }
```

The `details` object mirrors the same change: `result` → `resultPath`.

##### 2g. Update `completionMessage`

`completionMessage` already accepts `record: PersistedSubagentRecord`. Only the message text changes.

Current message:
```
Subagent ${record.id} completed.
Call get_subagent_status({ id: "${record.id}" }) to retrieve the result.
```

New message (per Requirement 3):
```
Subagent ${record.id} completed.
Result file: ${record.outputFile}
```

Full function:
```ts
function completionMessage(record: PersistedSubagentRecord): string {
  return [
    `Subagent ${record.id} completed.`,
    `Result file: ${record.outputFile}`,
  ].join("\n");
}
```

**`notifyCompletion` call site:** The sole call to `completionMessage` is in `notifyCompletion` at the line:
```ts
const parts = completionMessage(pendingRecord).split("\n");
```
This already passes `record` — no signature change needed. The cohort logic inserts extra lines at index 1 (between the "completed" line and the "Result file" line):
```ts
if (active.length > 0) {
  parts.splice(1, 0, `${completed.length} out of ${cohort.length} subagents have completed. You will be notified when all complete.`);
} else if (finalCohort) {
  parts.splice(1, 0, `All ${cohort.length} subagents have completed.`);
}
```
This continues to work correctly: the inserted line appears between `Subagent ${id} completed.` and `Result file: ...`. No other changes to `notifyCompletion` are needed.

##### 2h. Update `spawn_subagent` spawn response (blocking and async)

**Async spawn response** (in `spawnTool.execute`, async branch):
Current response:
```ts
return {
  content: [{
    type: "text",
    text: `Spawned subagent ${record.id}. You will be notified when this subagent completes. Do not poll for result - continue with whatever other work you may have.`,
  }],
  details: { id: record.id, running: true },
};
```

New response includes `resultPath`:
```ts
return {
  content: [{
    type: "text",
    text: `Spawned subagent ${record.id}. Result will be at: ${record.outputFile}. You will be notified when this subagent completes. Do not poll for result - continue with whatever other work you may have.`,
  }],
  details: { id: record.id, running: true, resultPath: record.outputFile },
};
```

**Blocking spawn response** (in `spawnTool.execute`, blocking branch):
Already calls `formatStatus(completed)` which will return `resultPath` after the changes to `formatStatus` in 2f. No additional change needed.

##### 2i. Update `runChild` exit logic

Current `runChild` (lines ~677-682):
```ts
if (record.outputMode === "file") {
  fs.writeFileSync(record.outputFile!, `${finalOutput}\n`, { mode: 0o600 });
  record.result = record.outputFile;
} else {
  record.result = finalOutput;
}
```

New `runChild` — **mirrors `refreshRecordFromDisk` (2d) exactly.** Same three-way branch, same behavior in every edge case:

```ts
// Check if subagent already wrote to result file
const hasExistingResult =
  record.outputFile &&
  fs.existsSync(record.outputFile) &&
  fs.readFileSync(record.outputFile, "utf-8").trim().length > 0;

if (!hasExistingResult) {
  // Subagent did not write to result file — auto-save final output
  const finalOutput = extractFinalOutput(stdout);
  if (finalOutput && record.outputFile) {
    fs.writeFileSync(record.outputFile, `${finalOutput}\n`, { mode: 0o600 });
  } else if (stderr.trim()) {
    // Subagent produced only stderr, no stdout output.
    if (!record.error) record.error = stderr.trim();
    if (record.outputFile) {
      fs.writeFileSync(record.outputFile, "(error)\n", { mode: 0o600 });
    }
  } else if (record.outputFile) {
    // Edge case: neither stdout nor stderr produced content.
    fs.writeFileSync(record.outputFile, "(no output)\n", { mode: 0o600 });
  }
}
record.result = record.outputFile;
```

**Note on orthogonal stderr handling above this block:** The existing exit-code error check (lines ~672-675) remains unchanged:
```ts
if (finished.code !== 0 && !record.error)
  record.error =
    stderr.trim() ||
    `Subagent exited with code ${finished.code}${finished.signal ? ` (${finished.signal})` : ""}`;
```
This sets `record.error` when the process exits with a non-zero code, regardless of whether stdout had output. The result-file stderr branch above handles a **different** scenario: when stdout is empty but stderr has content (regardless of exit code), we write `"(error)"` to the result file and set `record.error` if not already set. Both checks coexist without redundancy:

| Exit code | Stdout output | Stderr content | Exit-code check sets `record.error`? | Result-file branch action |
|---|---|---|---|---|
| Non-zero | Yes | Any | Yes | Writes stdout to result file |
| Non-zero | No | Yes | Yes | Sets `record.error` (if unset), writes `"(error)"` |
| 0 | No | Yes | No | Sets `record.error`, writes `"(error)"` |
| 0 | No | No | No | Writes `"(no output)"` |

**Why `runChild` now mirrors `refreshRecordFromDisk`:** Both code paths produce identical outcomes for every edge case. When a subagent produces only stderr and no extractable stdout:
- Both set `record.error` to the stderr content.
- Both write `"(error)"` to `record.outputFile`.
- Both set `record.result = record.outputFile`, pointing to a valid, existing file.

The `hasExistingResult` guard ensures that if the subagent wrote its own result file, both paths preserve it untouched and do not set `record.error` from stderr (stderr diagnostic output should not override an explicitly-written success result).

##### 2j. Update `spawn_subagent` renderCall

Current:
```ts
renderCall(args, theme) {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("spawn_subagent "))}${args.async ? theme.fg("warning", "async") : "blocking"} ${theme.fg("accent", args.outputMode ?? "inline")}`,
    0, 0,
  );
},
```

Remove `outputMode`:
```ts
renderCall(args, theme) {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("spawn_subagent "))}${args.async ? theme.fg("warning", "async") : "blocking"}`,
    0, 0,
  );
},
```

**Trace to scope:**
- Requirement 1: Remove `outputMode` (2a, 2b, 2c, 2j)
- Requirement 2: Spawn response includes result path (2h, 2f)
- Requirement 3: Completion notification includes result path and no `get_subagent_status` instruction (2g)
- Requirement 5: Auto-save subagent final message if result file empty (2d, 2i)
- Requirement 6: Path format `<parentSessionDir>/subagents/<id>/result.md` — already achieved by `childDir()` + `makeRecord` setting `outputFile: path.join(dir, "result.md")` where `dir = childDir(parentId, id)`. No change needed.
- Requirement 7: `get_subagent_status` continues to report running state — `formatStatus` retains `id` and `running` fields. `doNotPollNotice` is preserved.

---

#### **`extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts`**

##### 3a. Define RESULT_PATH env var name

Add export (alongside existing env var exports):
```ts
export const SUBAGENT_RESULT_PATH_ENV = "PI_SUBAGENT_RESULT_PATH";
```

##### 3b. Update `registerSubagentPromptRuntime`

Inject result path information into the subagent's system prompt when the env var is set. **The injection must be idempotent** — the `before_agent_start` hook can fire multiple times (e.g., on subagent restart). Use a marker substring `Your result file:` to detect a prior injection.

```ts
const RESULT_PATH_MARKER = "Your result file:";

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
    if (intercomSessionName && typeof pi.setSessionName === "function") {
      pi.setSessionName(intercomSessionName);
    }

    let rewritten = rewriteSubagentPrompt(event.systemPrompt);

    const resultPath = process.env[SUBAGENT_RESULT_PATH_ENV]?.trim();
    if (resultPath && !rewritten.includes(RESULT_PATH_MARKER)) {
      rewritten = `${rewritten}\n\nYour result file: ${resultPath}\nYou may write your final output to this file at any time using any tool (e.g., write, bash). If you leave the file empty, your final assistant message will be automatically saved there on exit.`;
    }

    if (rewritten === event.systemPrompt) return;
    return { systemPrompt: rewritten };
  });
}
```

##### 3c. Update `rewriteSubagentPrompt` signature

No changes needed — the existing function only prepends `CHILD_SUBAGENT_SYSTEM_LINE` if absent. The result-path injection happens after the rewrite in `registerSubagentPromptRuntime`.

**Trace to scope:**
- Requirement 4: Subagent informed of result file path via injected prompt.

**Edge cases:**
- If `PI_SUBAGENT_RESULT_PATH` env var is absent (e.g., non-subagent child process), the prompt is not augmented.
- **Idempotency:** The `before_agent_start` hook checks `!rewritten.includes(RESULT_PATH_MARKER)` before appending. If the marker is already present (from a previous hook invocation), the injection is skipped. The marker check is done on `rewritten` (post `rewriteSubagentPrompt`) so it works even if the `CHILD_SUBAGENT_SYSTEM_LINE` was prepended.
- If result path contains special characters (e.g., spaces), the `write` tool handles such paths. The path is safe since `childDir` uses session-derived paths with no user-controlled characters besides the subagent ID (which is a UUID-like string).

---

#### **`extensions/pi-subagents/src/runs/shared/pi-args.ts`**

##### 4a. Pass result path env var to child process

In `BuildPiArgsInput`, add the `resultPath` field:

```ts
interface BuildPiArgsInput {
  // ... existing fields ...
  resultPath?: string;  // NEW
}
```

In `buildPiArgs`, after existing env assignments (after `if (input.runId)...`), add:
```ts
if (input.resultPath) env.PI_SUBAGENT_RESULT_PATH = input.resultPath;
```

##### 4b. Update caller in `index.ts`

In `buildArgsForRecord`, the result path is already known: `record.outputFile`. Update `buildArgsForRecord` to pass `resultPath`:

```ts
function buildArgsForRecord(
  ctx: ExtensionContext,
  record: PersistedSubagentRecord,
  task: string,
): {
  args: string[];
  env: Record<string, string | undefined>;
  tempDir?: string;
} {
  // ... existing logic (sessionFile resolution) unchanged ...
  return buildPiArgs({
    baseArgs: [],
    task,
    sessionEnabled: true,
    sessionFile,
    model: record.model,
    intercomSessionName: `subagent-${record.id}`,
    runId: record.id,
    resultPath: record.outputFile,  // NEW
  });
}
```

**Trace to scope:**
- Requirement 4: Subagent receives result file path via environment variable, which the prompt injection extension uses.

---

### Dependencies

- **Node.js** `>=20` (existing requirement; uses `--experimental-strip-types`)
- **typebox** `^1.1.24` (existing dep; used for schema definition)
- **@earendil-works/pi-coding-agent** `^0.74.0` (existing peer dep)
- **@earendil-works/pi-agent-core** `^0.74.0` (existing peer dep)

No new dependencies.

---

### Testing Strategy

All tests in `test/unit/minimal-subagents.test.ts`. Each test traces to a scope requirement. A new integration test (Test 10) verifies the end-to-end behavior required by the scope test plan.

#### Test 1: Schema excludes outputMode (Requirement 1)

Update the existing schema test (line ~176) to remove `outputMode` from the expected keys:

```ts
test('schemas expose minimal three-tool parameter shapes', async () => {
  assert.equal(SpawnSubagentParams.additionalProperties, false);
  assert.deepEqual(
    Object.keys(SpawnSubagentParams.properties).sort(),
    ['async', 'cwd', 'keepContext', 'model', 'task', 'timeout'].sort(),
  );
  assert(!('outputMode' in SpawnSubagentParams.properties));
  // ... rest unchanged ...
});
```

#### Test 2: Spawn response includes resultPath (Requirement 2)

```ts
test('spawn response includes resultPath', async () => {
  const mockPi = createMockPi();
  mockPi.install();
  mockPi.onCall({ output: 'hello', exitCode: 0 });

  const { sessionId, ctx } = makeTestCtx('pi-subagents-resultpath-spawn');
  const { spawnTool } = registerTestTools(() => {});

  try {
    const result = await spawnTool.execute(
      'resultpath-child',
      { task: 'echo hello', async: false, keepContext: false },
      new AbortController().signal,
      undefined,
      ctx,
    );
    // resultPath must be present in details
    assert.ok(result.details.resultPath, 'resultPath must be present');
    assert.match(
      result.details.resultPath,
      /subagents\/resultpath-child\/result\.md$/,
    );
    // result file must exist and contain output
    const content = fs.readFileSync(result.details.resultPath, 'utf-8');
    assert.match(content, /hello/);
  } finally {
    mockPi.uninstall();
    cleanupTestCtx(ctx, sessionId);
  }
});
```

#### Test 3: Async spawn response includes resultPath (Requirement 2)

```ts
test('async spawn response includes resultPath', async () => {
  const mockPi = createMockPi();
  mockPi.install();
  mockPi.onCall({ output: 'async done', exitCode: 0 });

  const { sessionId, ctx } = makeTestCtx('pi-subagents-async-resultpath');
  const { spawnTool } = registerTestTools(() => {});

  try {
    const result = await spawnTool.execute(
      'async-resultpath-child',
      { task: 'finish', async: true, keepContext: false, timeout: 30 },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.ok(result.details.resultPath, 'resultPath must be present');
    assert.match(
      result.details.resultPath,
      /subagents\/async-resultpath-child\/result\.md$/,
    );
  } finally {
    mockPi.uninstall();
    cleanupTestCtx(ctx, sessionId);
  }
});
```

#### Test 4: Completion notification includes resultPath, not get_subagent_status (Requirement 3)

```ts
test('completion notification includes resultPath and does not reference get_subagent_status', async () => {
  const mockPi = createMockPi();
  mockPi.install();
  mockPi.onCall({ output: 'notified', exitCode: 0 });

  const { sessionId, ctx } = makeTestCtx('pi-subagents-notify-resultpath');
  const sentMessages: string[] = [];
  const { spawnTool } = registerTestTools((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') sentMessages.push(content);
  });

  try {
    await spawnTool.execute(
      'notify-resultpath-child',
      { task: 'finish', async: true, keepContext: false, timeout: 30 },
      new AbortController().signal,
      undefined,
      ctx,
    );

    await waitForPersistedRecord(
      sessionId,
      'notify-resultpath-child',
      (candidate) => !candidate.running && candidate.notifiedCompletion === true,
    );

    const completionMessage = sentMessages.find((m) =>
      m.includes('notify-resultpath-child') && m.includes('completed'),
    );
    assert.ok(completionMessage, 'completion message must exist');
    assert.match(completionMessage!, /Result file:/);
    assert.match(completionMessage!, /result\.md/);
    assert(
      !completionMessage!.includes('get_subagent_status'),
      'completion message must not mention get_subagent_status',
    );
  } finally {
    mockPi.uninstall();
    cleanupTestCtx(ctx, sessionId);
  }
});
```

#### Test 5: get_subagent_status returns resultPath, not inline result (Requirement 7)

```ts
test('get_subagent_status returns resultPath for completed subagent', async () => {
  const mockPi = createMockPi();
  mockPi.install();
  mockPi.onCall({ output: 'status check', exitCode: 0 });

  const { sessionId, ctx } = makeTestCtx('pi-subagents-status-resultpath');
  const { spawnTool, statusTool } = registerTestTools(() => {});

  try {
    await spawnTool.execute(
      'status-resultpath-child',
      { task: 'finish', async: false, keepContext: false },
      new AbortController().signal,
      undefined,
      ctx,
    );

    const status = await statusTool.execute(
      'status-call',
      { id: 'status-resultpath-child' },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(status.details.running, false);
    assert.ok(status.details.resultPath, 'status must include resultPath');
    assert.match(status.details.resultPath, /result\.md$/);
    // result file must contain output
    const content = fs.readFileSync(status.details.resultPath, 'utf-8');
    assert.match(content, /status check/);
  } finally {
    mockPi.uninstall();
    cleanupTestCtx(ctx, sessionId);
  }
});
```

#### Test 6: Subagent auto-saves final message when result file empty (Requirement 5)

```ts
test('auto-saves final assistant message to result file when subagent does not write to it', async () => {
  const mockPi = createMockPi();
  mockPi.install();
  // Subagent produces output but does NOT write to result file
  mockPi.onCall({ output: 'auto-saved output', exitCode: 0 });

  const { sessionId, ctx } = makeTestCtx('pi-subagents-autosave');
  const { spawnTool } = registerTestTools(() => {});

  try {
    const result = await spawnTool.execute(
      'autosave-child',
      { task: 'do work without writing result file', async: false, keepContext: false },
      new AbortController().signal,
      undefined,
      ctx,
    );

    const content = fs.readFileSync(result.details.resultPath, 'utf-8');
    assert.match(content, /auto-saved output/);
  } finally {
    mockPi.uninstall();
    cleanupTestCtx(ctx, sessionId);
  }
});
```

#### Test 7: Subagent-written result file takes precedence (Requirement 5)

This test pre-creates the child directory and `result.md` **before** calling `spawnTool.execute`. This is safe because `makeRecord` (called inside `execute`) uses `fs.mkdirSync(dir, { recursive: true })`, which is idempotent — it does not delete or overwrite an existing directory or its contents. The pre-created `result.md` is preserved.

```ts
test('subagent-written result file content is preserved, not overwritten', async () => {
  const mockPi = createMockPi();
  mockPi.install();

  const { sessionId, ctx } = makeTestCtx('pi-subagents-preserve');
  const { spawnTool } = registerTestTools(() => {});

  try {
    // Pre-create the result file BEFORE spawning.
    // makeRecord uses fs.mkdirSync(dir, { recursive: true }) — idempotent, safe.
    const childDir = path.join(
      storeDir(sessionId),
      'subagents',
      'preserve-child',
    );
    fs.mkdirSync(childDir, { recursive: true });
    const resultPath = path.join(childDir, 'result.md');
    fs.writeFileSync(resultPath, 'pre-written by subagent\n', 'utf-8');

    mockPi.onCall({ output: 'different stdout output', exitCode: 0 });

    // Blocking spawn — the pre-created result file must survive unmodified.
    const result = await spawnTool.execute(
      'preserve-child',
      { task: 'finish', async: false, keepContext: false },
      new AbortController().signal,
      undefined,
      ctx,
    );

    const content = fs.readFileSync(result.details.resultPath, 'utf-8');
    assert.equal(content.trim(), 'pre-written by subagent');
    // Must NOT contain the stdout output
    assert(!content.includes('different stdout output'));
  } finally {
    mockPi.uninstall();
    cleanupTestCtx(ctx, sessionId);
  }
});
```

#### Test 8: Prompt injection includes result path (Requirement 4)

This test verifies the prompt injection logic directly, including idempotency (the marker check prevents double-injection).

```ts
test('subagent system prompt includes result file path when env var set', () => {
  const prompt = 'Original system prompt.';
  const resultPath = '/tmp/subagents/abc/result.md';
  process.env.PI_SUBAGENT_RESULT_PATH = resultPath;

  // Simulate the handler's logic (mirrors registerSubagentPromptRuntime):
  const RESULT_PATH_MARKER = 'Your result file:';
  let rewritten = rewriteSubagentPrompt(prompt);
  if (resultPath && !rewritten.includes(RESULT_PATH_MARKER)) {
    rewritten = `${rewritten}\n\nYour result file: ${resultPath}\nYou may write your final output to this file at any time using any tool (e.g., write, bash). If you leave the file empty, your final assistant message will be automatically saved there on exit.`;
  }

  assert.ok(rewritten.includes(resultPath));
  assert.ok(rewritten.includes('Your result file:'));
  assert.ok(rewritten.includes('write'));
  assert.ok(rewritten.includes('automatically saved'));

  // Idempotency: second injection must not append again
  let rewrittenAgain = rewritten;
  if (resultPath && !rewrittenAgain.includes(RESULT_PATH_MARKER)) {
    rewrittenAgain = `${rewrittenAgain}\n\nYour result file: ${resultPath}\nYou may write...`;
  }
  assert.equal(rewrittenAgain, rewritten, 'prompt injection must be idempotent');

  delete process.env.PI_SUBAGENT_RESULT_PATH;
});
```

#### Test 9: pi-args passes resultPath env var (Requirement 4)

```ts
test('buildPiArgs includes PI_SUBAGENT_RESULT_PATH when resultPath provided', () => {
  const resultPath = '/tmp/subagents/test/result.md';
  const built = buildPiArgs({
    baseArgs: [],
    task: 'hello',
    sessionEnabled: true,
    sessionFile: '/tmp/test/session.jsonl',
    resultPath,
  });
  assert.equal(built.env.PI_SUBAGENT_RESULT_PATH, resultPath);
});

test('buildPiArgs omits PI_SUBAGENT_RESULT_PATH when resultPath not provided', () => {
  const built = buildPiArgs({
    baseArgs: [],
    task: 'hello',
    sessionEnabled: true,
    sessionFile: '/tmp/test/session.jsonl',
  });
  assert.equal(built.env.PI_SUBAGENT_RESULT_PATH, undefined);
});
```

#### Test 10: Integration — end-to-end blocking subagent with real pi binary (Scope Test Plan)

This test fulfills the scope's explicit integration test requirement: *"use `bash` to run `pi --mode json --print` with a prompt that spawns a blocking subagent performing a trivial task... Verify the parent session directory at `<parentSessionDir>/subagents/<id>/result.md` exists and contains the subagent's output."*

The test uses `spawnSync` (Node built-in, same pattern as `executeSubagentToolInFreshProcess`) instead of `bash` for portability, but the effect is identical — it spawns a real `pi` process.

```ts
test('integration: blocking subagent writes result.md at expected path', () => {
  // Find the pi binary
  const piBin = process.env.PI_BIN || 'pi';

  // Create a temp session file so we can inspect the result
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-int-'));
  const sessionFile = path.join(tmpDir, 'session.jsonl');
  const sessionId = path.basename(tmpDir);

  try {
    // Run pi with a prompt that spawns a blocking subagent
    const result = spawnSync(
      piBin,
      [
        '--mode', 'json',
        '--print',
        '--session', sessionFile,
        '--extension', path.join(projectRoot, 'src', 'index.ts'),
        'Spawn a blocking subagent to echo hello world. Use spawn_subagent with async: false. Then read the result file at the path given in resultPath.',
      ],
      {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 120_000,  // 2 min for LLM round-trip
        env: { ...process.env, PI_NO_COLOR: '1' },
      },
    );

    assert.equal(result.status, 0, `pi exited non-zero: ${result.stderr?.slice(0, 500)}`);

    // The parent should have read the result file, so it knows where it is.
    // Verify the result file exists at the expected path pattern.
    const subagentsDir = path.join(tmpDir, 'subagents');
    assert.ok(
      fs.existsSync(subagentsDir),
      `subagents dir must exist under session dir: ${subagentsDir}`,
    );

    const subagentDirs = fs.readdirSync(subagentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    assert.ok(subagentDirs.length >= 1, 'at least one subagent dir must exist');

    for (const dir of subagentDirs) {
      const resultPath = path.join(subagentsDir, dir.name, 'result.md');
      assert.ok(
        fs.existsSync(resultPath),
        `result.md must exist: ${resultPath}`,
      );
      const content = fs.readFileSync(resultPath, 'utf-8');
      assert.ok(content.trim().length > 0, `result.md must not be empty: ${resultPath}`);
    }
  } finally {
    // Best-effort cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
```

**Note:** Test 10 requires a running LLM backend (the `pi` binary must be able to process the prompt). If no backend is available, this test will be skipped or marked as requiring `--integration` flag. This matches the scope's delivery requirement: *"After merge, verify by running `pi --mode json --print`..."*

---

### Test Updates to Existing Tests

Every existing test that passes `outputMode: 'inline'` in spawn params must remove that field. The affected test calls (by line number — will shift after edits):

| Test name | Child ID | Line (approx) |
|-----------|----------|---------------|
| async completion persists... | stale-notify-child | 287 |
| get_subagent_status retries... | retry-status-child | 332 |
| list_subagents retries... | retry-list-child | 386 |
| notification failures do not... | notify-failure-child | 432 |
| stale final cohort... | stale-final-cohort-first | 478 |
| stale final cohort... | stale-final-cohort-second | 485 |
| async timeout notifies... | timeout-child | 561 |
| stale async timeout... | stale-timeout-retry-child | 612 |
| spawn_subagent retries... | stale-timeout-spawn-retry-child | 673 |
| spawn_subagent retries... (trigger) | timeout-retry-trigger-child | 695 |
| stale async timeout not retried... | stale-timeout-completed-child | 733 |
| stale async completion... | stale-retry-child | 789 |
| stale cohort notification... | stale-cohort-first | 871 |
| stale cohort notification... | stale-cohort-second | 878 |

For each, remove `outputMode: 'inline',` from the params object. Also update assertions that check `result` in `details` to check `resultPath` instead. Specifically:

- Existing tests that assert `status.details.result === 'done'` must change to check the **content** of `resultPath` (by reading the file) since `details.result` is now `details.resultPath`.
- Test "async completion persists success..." (line ~287+): change `assert.equal(record.result, 'done')` to read the result file.
- Test "get_subagent_status retries..." (line ~332+): change `assert.equal(status.details.result, 'done')` to check `resultPath` + file content.
- Tests that already read the persisted `record.result` (like "notification failures do not...") must change to read the file at `record.outputFile`.

---

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Race condition: parent reads result file before subagent finishes writing.** | The file-system write in `runChild` happens before `record.result` is set and before the completion notification fires. For async subagents, the parent is told to wait for notification. The `fs.writeFileSync` call and the completion notification are serialized in the same promise chain via `child.on("close")`. |
| **Result file path stability across session restarts.** | Per Non-Goals: path stability is only guaranteed within a single parent session lifetime. No mitigation needed. |
| **Existing tests break because they pass `outputMode` and assert `details.result`.** | All test calls to `spawn_subagent` must remove `outputMode: 'inline'`. All assertions on `details.result` or `record.result` must be updated to check `details.resultPath` + file content. |
| **Idempotency of prompt injection.** | The `before_agent_start` hook checks for the `Your result file:` marker substring before appending. If the marker is already present (from a previous hook invocation), the injection is skipped. |
| **Special characters in result path.** | The result path is entirely derived from `getBaseDir()` → `childDir()` → `record.outputFile`. The `subagentId` is a UUID created by Pi core, so no shell-special characters. The parent session dir may contain paths with spaces (e.g., `/Users/foo/Documents/project`). fs operations handle this naturally. |
| **Stderr-only subagent: `record.result` points to nonexistent file.** | Both `refreshRecordFromDisk` and `runChild` handle this edge case with a three-way branch. When only stderr content exists (no stdout), `"(error)"` is written to the result file. The result file always exists after either function returns. |
| **`runChild` and `refreshRecordFromDisk` diverge in behavior.** | Both functions use identical logic: `hasExistingResult` guard → three-way branch (stdout / stderr+error / placeholder) → `record.result = record.outputFile`. The stderr error assignment in `runChild`'s exit-code check (above the result-file block) is orthogonal — it handles non-zero exit codes regardless of stdout content. |
| **Empty stdout (no extractable assistant message) and empty stderr.** | Both `refreshRecordFromDisk` and `runChild` handle this edge case by writing `"(no output)"` to the result file, ensuring the parent always gets a non-empty file. |
| **makeRecord overwrites pre-created result file (Test 7).** | `makeRecord` uses `fs.mkdirSync(dir, { recursive: true })` which is idempotent and does not delete or overwrite existing files. This is verified in Test 7. |

---

### Implementation Order

**Phase 1: Schema and types**
1. Edit `schemas.ts` — Remove `outputMode` from `SpawnSubagentParams` and `SpawnSubagentParamsLike`.

**Phase 2: Extension core**
2. Edit `index.ts`:
   - Remove `OutputMode` type alias (2a)
   - Remove `outputMode` from `PersistedSubagentRecord` (2b)
   - Remove `outputMode` from `makeRecord` (2c)
   - Rewrite `refreshRecordFromDisk` (2d) — three-way branch with `"(error)"` placeholder for stderr-only case
   - Simplify `resultForRecord` (2e) — always return `outputFile`
   - Update `formatStatus` (2f) — rename `result` → `resultPath` in JSON + details; keep `doNotPollNotice`
   - Update `completionMessage` (2g) — new message text with `Result file:`
   - Update `spawn_subagent` spawn response (2h) — add `resultPath` to async response
   - Update `runChild` exit logic (2i) — mirror 2d exactly: `hasExistingResult` guard + three-way branch
   - Update `renderCall` (2j) — remove `outputMode` display

**Phase 3: Prompt injection**
3. Edit `subagent-prompt-runtime.ts`:
   - Export `SUBAGENT_RESULT_PATH_ENV` (3a)
   - Inject result path into system prompt with idempotency check (3b)

**Phase 4: Env var plumbing**
4. Edit `pi-args.ts` — Add `resultPath` to `BuildPiArgsInput`, pass it as `PI_SUBAGENT_RESULT_PATH` env var. (4a)
5. Edit `buildArgsForRecord` in `index.ts` — Pass `record.outputFile` as `resultPath`. (4b)

**Phase 5: Tests**
6. Edit `minimal-subagents.test.ts`:
   - Remove all `outputMode: 'inline'` from spawn calls (14 locations, see table above)
   - Update existing assertions: `details.result` → `details.resultPath` + file content checks
   - Update existing schema test to expect no `outputMode` (Test 1)
   - Add Tests 2-9 (new test code as specified above)
   - Add Test 10 (integration test)

**Phase 6: Verify**
7. Run `npm run test:unit`.
8. Run Test 10 (integration test), which requires a live LLM backend.

---

### Verification Checklist

- [ ] `outputMode` is absent from `SpawnSubagentParams.properties` keys.
- [ ] `outputMode` is absent from TypeScript interface `SpawnSubagentParamsLike`.
- [ ] `OutputMode` type alias removed from `index.ts`.
- [ ] `outputMode` field removed from `PersistedSubagentRecord`.
- [ ] `outputMode` field removed from `makeRecord`.
- [ ] `refreshRecordFromDisk` checks for existing result file before writing.
- [ ] `refreshRecordFromDisk` auto-saves extracted output when result file empty.
- [ ] `refreshRecordFromDisk` writes `"(error)"` placeholder when only stderr has content (no stdout).
- [ ] `refreshRecordFromDisk` writes `"(no output)"` placeholder when stdout and stderr are both empty.
- [ ] `runChild` exit logic mirrors `refreshRecordFromDisk` exactly: `hasExistingResult` guard + three-way branch.
- [ ] `runChild` writes `"(error)"` placeholder when only stderr has content (no stdout).
- [ ] `runChild` writes `"(no output)"` placeholder when no extractable output.
- [ ] `runChild` exit-code error check (above result-file block) remains unchanged and orthogonal.
- [ ] `resultForRecord` always returns `outputFile`.
- [ ] `formatStatus` returns `resultPath` in both `content` JSON and `details`.
- [ ] `formatStatus` preserves `doNotPollNotice` for running subagents.
- [ ] `completionMessage` includes `Result file: <path>`.
- [ ] `completionMessage` does NOT mention `get_subagent_status`.
- [ ] Spawn response (blocking and async) includes `resultPath`.
- [ ] `runChild` respects pre-existing result file content.
- [ ] `renderCall` for `spawn_subagent` no longer displays `outputMode`.
- [ ] `subagent-prompt-runtime.ts` injects `Your result file: <path>` into prompt when env var set.
- [ ] Prompt injection is idempotent (marker check prevents double-injection).
- [ ] `pi-args.ts` passes `PI_SUBAGENT_RESULT_PATH` env var when `resultPath` provided.
- [ ] `buildArgsForRecord` passes `record.outputFile` as `resultPath`.
- [ ] All existing tests updated: `outputMode` removed from params, `result` assertions updated to `resultPath` + file content.
- [ ] All new tests (1-10) pass.
- [ ] `get_subagent_status` still works and returns `id`, `running`, `resultPath`.
- [ ] Integration test (Test 10): `result.md` exists at `<parentSessionDir>/subagents/<id>/result.md` and contains output.
