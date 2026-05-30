---
name: spec-execute
description: Execute an approved plan using subagents only. The parent agent orchestrates—spawning implementation subagents and reviewer subagents—but never writes code itself. Reviewers verify every change against the plan and scope before TODO items are checked off.
version: 1
created: 2026-05-30
---

## When to Use

Invoke after `spec-plan` has an APPROVED verdict and the plan is immutable.

Prerequisites:
- Scope file is frozen and immutable
- Plan file is approved and immutable (reviewer gave unqualified APPROVED)
- No code has been written yet for this feature

## Procedure

### Phase 1: Bootstrap

#### 1. Create the TODO checklist
Read the plan document. Create a TODO checklist at `docs/specs/<feature-slug>/TODO.md` that breaks down every implementation item from the plan into granular, checkable tasks.

The TODO format:
```markdown
# <Feature Name> — TODO

## Legend
- `[ ]` — Not started
- `[~]` — In progress (subagent working)
- `[x]` — Done (implemented AND reviewed)

## Tasks
### Phase 1: <phase name>
- [ ] **TASK-ID-001**: <description> → File: `<path>`, Reviewer: `<subagent-id or pending>`

### Phase 2: <phase name>
...
```

Rules for TODO:
- One task per logical unit of work. Typically one file = one task, but complex files may be split.
- Tasks are grouped by implementation phases from the plan.
- A task is NOT done until BOTH implemented AND reviewed.
- The TODO file is the single source of truth for execution progress.

### Phase 2: Execute

#### 2. Spawn implementation subagents
For each phase, spawn implementation subagents. Follow the plan's implementation order.

**Parallel execution rule:** Tasks within the same phase that have no mutual dependencies can (and should) be executed in parallel. Tasks across phases must be sequential—phase N must complete before phase N+1 starts.

Implementation subagent prompt (use verbatim):

```
You are executing an approved implementation plan.

READ ONLY (do not modify these files):
- Scope: <scope_path>
- Plan: <plan_path>

READ/WRITE:
- TODO: <todo_path> (update checkboxes to [x] when YOUR tasks are done)

YOUR TASK:
<specific task description from TODO>

Rules:
1. Read the scope and plan to understand the full picture.
2. Implement ONLY what is assigned to you. Do not touch files assigned to other tasks.
3. Follow the plan verbatim. Do not improvise, optimize, or add "nice to haves."
4. After completing implementation, mark your TODO items as [x] by editing the TODO file.
5. Use `<subagent-id>` as your identifier so your work can be traced.

Your subagent ID: <subagent-id>
```

Replace `<scope_path>`, `<plan_path>`, `<todo_path>`, and `<subagent-id>` with actual values.

#### 3. Spawn reviewer subagents for each implementation task
After an implementation subagent finishes, spawn a reviewer subagent to verify the work before checking off the TODO item.

**Reviewer subagent prompt (use verbatim):**

```
You are a neutral, skeptical code reviewer. Your job is to verify that
implementation work matches the approved plan.

READ ONLY:
- Scope: <scope_path>
- Plan: <plan_path>
- TODO: <todo_path>

VERIFY:
- File(s) implemented: <file_paths>

Rules:
1. Read the scope to understand the goals and constraints.
2. Read the plan to understand what should be implemented.
3. Inspect the implemented files. Check that:
   a. Every plan instruction for these files is implemented exactly as specified.
   b. Nothing extra is implemented beyond what the plan specifies.
   c. The implementation aligns with scope goals and does not violate constraints.
   d. Edge cases mentioned in the plan are handled.
   e. The code is correct and complete.
4. Read the TODO to see which task(s) claim to be done.

Respond in exactly this format:

VERDICT: [APPROVED | CHANGES NEEDED]

If APPROVED:
- Confirm the implementation matches the plan verbatim.
- List the TODO task IDs that can be marked as verified.

If CHANGES NEEDED:
- List specific discrepancies between plan and implementation.
- Group into: MISSING (plan item not implemented), EXTRA (code not in plan),
  WRONG (implementation contradicts plan), INCOMPLETE (plan item partially done).
- Do NOT suggest fixes. Only identify problems.
```

Replace placeholders with actual paths.

**If CHANGES NEEDED:** Feed the reviewer feedback back to the implementation subagent for fixes. Re-review after fixes.

**If APPROVED:** Mark the TODO task as verified. Add the reviewer's subagent ID as the verifier.

### Phase 3: Final Verification

#### 4. Full-spec review
After all TODO items are checked off, spawn one final reviewer subagent for a complete end-to-end review:

```
You are a neutral, skeptical code reviewer performing the FINAL verification.

READ ONLY:
- Scope: <scope_path>
- Plan: <plan_path>
- TODO: <todo_path>

The TODO claims all tasks are complete. Verify this is true by:
1. Reading the scope and confirming every requirement is satisfied.
2. Reading the plan and confirming every instruction is implemented.
3. Checking that no scope constraint is violated.
4. Checking that no non-goal was accidentally implemented.
5. Running any build, lint, or test commands specified in the plan.

Respond in exactly this format:

FINAL VERDICT: [PASS | FAIL]

If PASS:
- Confirm the implementation is complete and aligned.
- No caveats. Fully satisfied.

If FAIL:
- List every gap, bug, or misalignment found.
```

#### 5. Report completion
When the final reviewer returns PASS:
- Report to the user: "Implementation complete. All tasks verified. Final review passed."
- List what was built and where.

## Critical Rules

1. **Parent NEVER implements.** The parent agent only spawns subagents, feeds feedback, and updates the TODO. Never write code directly.
2. **Subagents NEVER modify scope, plan, or TODO.** The TODO is only updated by the parent after reviewer approval. Implementation subagents may mark their own items as `[x]` but the parent must confirm via reviewer before considering them truly done.
3. **No task is done without review.** Every implementation change must be verified by a neutral reviewer subagent.
4. **Reviewers are neutral.** Give them only file paths. No extra context, no hints, no nudging.
5. **Reviewers find problems, never suggest fixes.** Their output is a list of discrepancies, period.

## Pitfalls
- Do NOT skip the reviewer. Even "trivial" changes must be reviewed.
- Do NOT spawn a reviewer that also wrote the code. Reviewers must be fresh subagents.
- Do NOT check off TODO items based on implementation subagent self-report alone. Always verify through reviewer.
- Do NOT implement anything not in the plan. If you discover a gap, surface it to the user—do not improvise.
- Do NOT modify scope, plan, or TODO outside the defined process. They are the contract.
- If reviewer and implementer disagree, prefer the reviewer. The reviewer's job is to enforce the contract.

## Verification
- All TODO items are `[x]` with reviewer verification
- Final reviewer returned PASS with no caveats
- All build/lint/test commands pass (verified by final reviewer)
- No scope violations, no plan deviations
