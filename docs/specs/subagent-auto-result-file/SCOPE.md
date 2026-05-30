# Subagent Auto-Result-File — Scope

## Motivation
Subagents currently require the parent to call `get_subagent_status` to retrieve results. The `outputMode` param adds unnecessary complexity. Results should always be written to a predictable file path, shared with the parent at spawn and completion, consumable with the standard `read` tool.

## Goals
- Parent receives result file path at subagent spawn time and in the completion notification.
- Parent retrieves subagent results using the standard `read` tool — no specialized tool call needed.
- Subagent is aware of its result file path and may write to it programmatically at any time.

## Requirements
1. The `outputMode` parameter must be removed from `spawn_subagent`; subagent results are always written to a file.
2. The spawn response must include the result file path alongside the subagent ID.
3. Subagent completion notification must include the result file path. The notification must not instruct the parent to call `get_subagent_status` for result retrieval.
4. The subagent must be informed (via injected prompt) of its result file path. It must know it may write final output to that file at any time using any tool. It must know that if the file is left empty, its final assistant message will be auto-saved there on exit.
5. At subagent exit: if the result file has content, that content is the subagent result. If the result file is empty or absent, the subagent's final assistant message from stdout must be extracted and written to the result file.
6. The result file path must be stable and predictable: `<parentSessionDir>/subagents/<subagentId>/result.md`.
7. `get_subagent_status` must continue to report the subagent's running state (`{ id, running }`) and must not be required for result retrieval.

## Restrictions
- The subagent result file must reside within the subagent's child directory under the parent session directory.

## Constraints
- The `spawn_subagent` tool schema (TypeBox) must be updated to remove `outputMode`.
- The subagent prompt injection extension (`subagent-prompt-runtime.ts`) must be updated to include result-path information.

## Non-Goals / Out of Scope
- Backward compatibility with existing parent sessions that call `get_subagent_status` for results.
- Streaming partial results to the parent in real-time.
- Auto-reading the result file on behalf of the parent.
- Changing the subagent timeout mechanism.
- Changing the subagent recursion depth check.
- Persisting result files across parent session restarts; path stability is only guaranteed within a single parent session lifetime.
- Removing `get_subagent_status` entirely; it remains for running-state queries.
- Adding structured output formats (JSON schema, etc.) to subagent results.

## Test Plan
- Unit tests must verify: spawn response includes `resultPath`, completion notification includes `resultPath`, the `outputMode` param is absent from the schema.
- Integration test: use `bash` to run `pi --mode json --print` with a prompt that spawns a blocking subagent performing a trivial task (e.g., "echo hello"). Verify the parent session directory at `<parentSessionDir>/subagents/<id>/result.md` exists and contains the subagent's output.

## Delivery
- Changes must be submitted as a GitHub PR against `tasercake/pi-extensions@main` and merged.
- After merge, verify by running `pi --mode json --print` with a prompt that spawns a blocking subagent; inspect the created subagent session directory to confirm the result file exists at the expected path and contains the subagent's output.
