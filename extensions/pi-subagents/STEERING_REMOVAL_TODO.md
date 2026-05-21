# Steering Removal TODO

## Implementation tasks

- [x] Update `test/unit/minimal-subagents.test.ts` schema imports to remove `SteerSubagentParams`.
- [x] Rename schema test to `schemas expose minimal three-tool parameter shapes`.
- [x] Tighten schema test to assert `SpawnSubagentParams`, `GetSubagentStatusParams`, and `ListSubagentsParams` shapes only.
- [x] Add dynamic import assertion that `SteerSubagentParams` is not exported from `src/extension/schemas.ts`.
- [x] Final validation-backed schema coverage confirmed `SteerSubagentParams` is absent and minimal three-tool parameter shapes pass.
- [x] Remove `SteerSubagentParams` export from `src/extension/schemas.ts`.
- [x] Remove `SteerSubagentParamsLike` interface export from `src/extension/schemas.ts`.
- [x] Run focused schema test and confirm it passes after schema removal.
- [x] Add `registerSubagentExtension` import to `test/unit/minimal-subagents.test.ts`.
- [x] Add registration test `extension registers only spawn status and list tools` using fake `registerTool` collector.
- [x] Assert exact registered tool names are `spawn_subagent`, `get_subagent_status`, and `list_subagents`.
- [x] Assert `steer_subagent` is not registered.
- [x] Final validation-backed registration coverage confirmed only spawn/status/list tools register and removed APIs are absent.
- [x] Remove `SteerSubagentParams` and `SteerSubagentParamsLike` imports from `src/extension/index.ts`.
- [x] Delete full `steerTool` definition from `src/extension/index.ts`.
- [x] Verify deleting `steerTool` removes `steering.md` writes.
- [x] Verify deleting `steerTool` removes parent follow-up message appends.
- [x] Verify deleting `steerTool` removes `SIGUSR2` sends to running children.
- [x] Verify deleting `steerTool` removes completed-child follow-up `runChild(...)` behavior.
- [x] Delete `pi.registerTool(steerTool)` from `src/extension/index.ts`.
- [x] Verify final registration order is `spawnTool`, `statusTool`, `listTool`.
- [x] Run focused registration test and confirm it passes after registration removal.
- [x] Extend registration test with negative assertions for `steer_subagent`, `resume_subagent`, `follow_up_subagent`, and `interrupt_subagent`.
- [x] Run focused registration test again and confirm it passes.
- [x] Remove full `steer_subagent` section from `README.md`, including heading, TypeScript example, and explanatory sentence.
- [x] Verify `README.md` `## Tools` documents only `spawn_subagent`, `get_subagent_status`, and `list_subagents` in that order.
- [x] Add README finality note: completed children are final; running children continue original task; extension exposes only spawn/status/list.
- [x] Run README forbidden-term scan and confirm no matches: `rg -n 'steer_subagent|Queues a message|resumes a stopped|steering|follow-up|pause|resume|interrupt' README.md`.
- [x] Remove `steer_subagent({ id, message })` bullet from `skills/pi-subagents/SKILL.md`.
- [x] Add skill rule: `Available subagent tools are exactly the three listed above.`
- [x] Verify bundled skill does not add replacement workflow recipes or removed interactive terminology.
- [x] Run skill forbidden-term scan and confirm no matches: `rg -n 'steer_subagent|steering|follow-up|message queue|message-queue|pause|resume|interrupt|replacement' skills/pi-subagents/SKILL.md`.
- [x] Update `package.json` description to `Minimal recursive Pi child-subagent spawner with spawn, status, and list tools`.
- [x] Remove `CHANGELOG.md` from `package.json.files`.
- [x] Do not bump package version unless release owner explicitly asks.
- [x] Update `install.mjs` post-install output to list only `spawn_subagent`, `get_subagent_status`, and `list_subagents`.
- [x] Verify `install.mjs` contains no alternate follow-up, steering, resume, pause, interrupt, or message-queue wording.
- [x] Run package metadata check: `node -e "const p=require('./package.json'); if(/four tools|steer/i.test(p.description)) process.exit(1); if((p.files||[]).includes('CHANGELOG.md')) process.exit(2); console.log(p.description)"`.
- [x] Confirm package metadata check prints `Minimal recursive Pi child-subagent spawner with spawn, status, and list tools`.
- [x] Run installer/package forbidden-term scan and confirm no matches: `rg -n 'steer_subagent|steering|follow-up|message queue|message-queue|pause|resume|interrupt|four tools' install.mjs package.json`.
- [x] Add filesystem imports to `test/unit/minimal-subagents.test.ts`: `node:fs`, `node:path`, and `fileURLToPath` from `node:url`.
- [x] Add `__dirname` and `projectRoot` helpers, reusing existing helpers if present.
- [x] Add test `user-facing packaged docs do not expose removed API concepts`.
- [x] In docs/package test, assert `CHANGELOG.md` is not included in `package.json.files`.
- [x] In docs/package test, scan `README.md`, `skills/pi-subagents/SKILL.md`, `package.json`, and `install.mjs` for forbidden removed-API terms.
- [x] Run focused docs test and confirm it passes: `npm run test:unit -- --test-name-pattern='user-facing packaged docs do not expose removed API concepts'`.

## Neutral reviews

- [x] Request neutral implementation review against `STEERING_REMOVAL_PLAN.md` and `STEERING_REMOVAL_SCOPE.md`.
- [x] Ask reviewer to verify no replacement follow-up, resume, interrupt, pause, queue, acknowledgement, chat, or orchestration feature was added.
- [x] Ask reviewer to verify `spawn_subagent`, `get_subagent_status`, and `list_subagents` user-facing behavior stayed unchanged except steering removal.
- [x] Ask reviewer to verify no hidden/no-op `steer_subagent` compatibility shim remains.
- [x] Ask reviewer to verify persisted run records, process tracking, async notifications, result extraction, status, and list flows remain intact.
- [x] Ask reviewer to verify existing `steering.md` files are not read, migrated, or deleted.
- [x] Address any review findings with minimal scoped edits only.
- [x] Re-run affected focused tests after review fixes.

## Validation

- [x] Run full unit suite from `extensions/pi-subagents`: `npm run test:unit`.
- [x] Run package test alias from `extensions/pi-subagents`: `npm test`.
- [x] Run Node strip-types smoke test: `node --experimental-strip-types --test test/unit/*.test.ts`.
- [x] Search implementation and shipped docs for remaining steering internals: `rg -n 'SteerSubagentParams|SteerSubagentParamsLike|steerTool|steering\.md|SIGUSR2|Queued steering|Resumed subagent|follow-up from parent' src README.md skills package.json install.mjs`.
- [x] Confirm steering-internals search returns no matches.
- [x] Search package-controlled shipped surfaces: `rg -n 'steer_subagent|SteerSubagent|steering message|resumes a stopped subagent|follow-up|message queue|message-queue|four tools' src README.md skills package.json install.mjs --glob '!package-lock.json' --glob '!node_modules/**'`.
- [x] Confirm package-controlled shipped-surface search returns no matches.
- [x] Verify `CHANGELOG.md` is not packaged: `node -e "const p=require('./package.json'); if((p.files||[]).includes('CHANGELOG.md')) { console.error('CHANGELOG.md is still packaged'); process.exit(1); }"`.
- [x] Run `npm pack --json` and capture generated tarball name.
- [x] Inspect packed file list with `tar -tf`.
- [x] Confirm packed file list excludes `package/CHANGELOG.md`.
- [x] Confirm packed file list includes `package/README.md`.
- [x] Confirm packed file list includes `package/package.json`.
- [x] Confirm packed file list includes `package/install.mjs`.
- [x] Confirm packed file list includes `package/src/` files.
- [x] Confirm packed file list includes `package/skills/` files.
- [x] Extract packed tarball into a temp directory.
- [x] Scan extracted package for forbidden removed semantics: `rg -n 'steer_subagent|SteerSubagent|steering message|resumes a stopped subagent|follow-up|message queue|message-queue|four tools|Queued steering|Resumed subagent|follow-up from parent' "$TMP_DIR/package"`.
- [x] Confirm extracted-package scan returns no matches.
- [x] Remove temp directory and generated tarball after pack inspection.
- [x] Confirm final acceptance: `src/extension/index.ts` registers exactly three tools.
- [x] Confirm final acceptance: `src/extension/schemas.ts` exports no steering schema or steering params interface.
- [x] Confirm final acceptance: no extension path writes `steering.md`.
- [x] Confirm final acceptance: no extension path sends `SIGUSR2` for child steering.
- [x] Confirm final acceptance: no extension path resumes completed children with follow-up text.
- [x] Confirm final acceptance: `README.md` documents only spawn/status/list.
- [x] Confirm final acceptance: bundled skill documents only spawn/status/list and contains no removed API wording.
- [x] Confirm final acceptance: `package.json` description no longer says `four tools`.
- [x] Confirm final acceptance: `install.mjs` lists only spawn/status/list and contains no removed interaction wording.
- [x] Confirm final acceptance: `package.json.files` no longer includes `CHANGELOG.md`.

## PR

- [ ] Review working tree and confirm only intended implementation/test/docs/package files changed plus this TODO file.
- [ ] Confirm `STEERING_REMOVAL_SCOPE.md` was not modified.
- [ ] Confirm no unrelated implementation source or docs were modified beyond the steering-removal scope.
- [ ] Prepare concise commit message describing removal of steering tool surface.
- [ ] Open PR with summary of removed `steer_subagent` API surface.
- [ ] Include validation commands and pass/fail results in PR description.
- [ ] Note breaking compatibility: callers using `steer_subagent` must stop using it; no shim is provided.
- [ ] Note package tarball excludes `CHANGELOG.md` to avoid shipping historical removed-interaction wording.

## PR review

- [ ] Request PR review focused on exact three-tool model-visible surface.
- [ ] Request PR review focused on absence of steering/follow-up/resume/pause/interrupt/message-queue wording in shipped surfaces.
- [ ] Request PR review focused on no behavioral drift for spawn/status/list.
- [ ] Request PR review focused on tarball contents and package metadata.
- [ ] Address PR review comments with minimal scoped commits.
- [ ] Re-run full validation after PR review fixes.
- [ ] Update PR description with final validation results if fixes changed code.
- [ ] Merge only after tests, searches, pack inspection, and review are complete.
