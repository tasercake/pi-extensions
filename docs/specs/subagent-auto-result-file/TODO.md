# Subagent Auto-Result-File — TODO

## Legend
- `[ ]` — Not started
- `[~]` — In progress (subagent working)
- `[x]` — Done (implemented AND reviewed)

## Tasks

### Phase 1: Schema
- [x] **TASK-001**: Remove `outputMode` from `SpawnSubagentParams` and `SpawnSubagentParamsLike` → File: `extensions/pi-subagents/src/extension/schemas.ts`, Reviewer: `call_00_DpBIxFyb9P8EvtNOMPOX3590` ✅

### Phase 2: Extension core + env plumbing
- [x] **TASK-002**: Rewrite `index.ts` — remove `OutputMode` type, remove `outputMode` from record/makeRecord, rewrite `refreshRecordFromDisk` (three-way branch), simplify `resultForRecord`, update `formatStatus` (result→resultPath, keep doNotPollNotice), update `completionMessage` (Result file: <path>, no get_subagent_status), update spawn response (add resultPath), update `runChild` (mirror 2d), update `renderCall` (remove outputMode), update `buildArgsForRecord` (pass resultPath) → File: `extensions/pi-subagents/src/extension/index.ts`, Reviewer: `call_00_dl02SLTGfXTBYQUYDqRz1388` ✅

### Phase 3: Prompt injection + env plumbing
- [x] **TASK-003**: Update `subagent-prompt-runtime.ts` (export RESULT_PATH env var, inject result path with idempotency) and `pi-args.ts` (add resultPath to BuildPiArgsInput, pass PI_SUBAGENT_RESULT_PATH env var) → Files: `extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts`, `extensions/pi-subagents/src/runs/shared/pi-args.ts`, Reviewer: `call_00_ET_C8S5TjZLkV7CyVU7LynX8411` ✅

### Phase 4: Tests
- [x] **TASK-004**: Update `minimal-subagents.test.ts` — remove outputMode from 14 call sites, update assertions (result→resultPath), add Tests 1-10 per plan → File: `extensions/pi-subagents/test/unit/minimal-subagents.test.ts`, Reviewer: `call_00_eFU1GuZeeTHxmLGnWrQ36829` ✅

### Phase 5: Verify
- [x] **TASK-005**: Run `npm run test:unit` and integration test (Test 10), confirm all pass, submit PR and merge → Reviewer: `call_00_eFU1GuZeeTHxmLGnWrQ36829` ✅
