---
name: spec-execute
description: Execute an approved plan using subagents only. The parent agent orchestrates—spawning implementation subagents and reviewer subagents—but never writes code itself. Reviewers verify every change against the plan and scope before TODO items are checked off.
version: 1
created: 2026-05-30
---

## When to Use

Invoke after `spec-plan` has APPROVED the PLAN and TODO, and the plan is immutable.

Prerequisites:
- Scope file exists at `.spec/<slug>/SCOPE.md`, is frozen, and is immutable.
- Plan file exists at `.spec/<slug>/PLAN.md`, is approved, and is immutable.
- TODO file exists at `.spec/<slug>/TODO.md`, is approved, and remains mutable for parent progress updates.
- No code has been written yet for this feature.

## Procedure

### Phase 1: Load Approved Artifacts

#### 1. Read the approved workflow artifacts
Parent reads SCOPE, PLAN, and TODO from `.spec/<slug>/`:
- `.spec/<slug>/SCOPE.md`
- `.spec/<slug>/PLAN.md`
- `.spec/<slug>/TODO.md`

The execute phase must not generate, rewrite, reorganize, or reinterpret TODO.

Parent follows TODO phase ordering, dependencies, and allowed parallelism exactly as written. TODO is the source of progress truth. PLAN is the source of work-detail truth. SCOPE is the source of goal/constraint truth.

### Phase 2: Execute

#### 2. Spawn implementation subagents
For each phase, spawn implementation subagents according to the approved TODO. Follow TODO phase ordering, dependencies, and allowed parallelism exactly as written.

Before spawning an implementation subagent for a TODO task, parent updates that task from `[ ]` to `[~]` and records the implementation subagent ID if the TODO format has a field for it.

After implementation subagent completes, parent does not mark `[x]` until reviewer returns `APPROVED`.

Implementation subagent prompt (use verbatim):

```
You are executing an approved implementation plan.

READ ONLY (do not modify these files):
- Scope: <scope_path>
- Plan: <plan_path>
- TODO: <todo_path>

YOUR TASK:
<specific task description from TODO>

Rules:
1. Read the scope, plan, and TODO to understand the assigned work and execution order.
2. Implement ONLY what is assigned to you. Do not touch files assigned to other tasks.
3. Follow the approved PLAN and assigned TODO item verbatim. Do not improvise, optimize, derive new tasks, rewrite TODO, reorganize TODO, or add nice-to-haves.
4. Treat SCOPE, PLAN, and TODO as read-only. Do not update TODO checkboxes or reviewer fields.
5. Report completed files and any blockers to the parent.
6. Use `<subagent-id>` as your identifier so your work can be traced.

Your subagent ID: <subagent-id>
```

Replace `<scope_path>`, `<plan_path>`, `<todo_path>`, and `<subagent-id>` with actual values.

#### 3. Spawn reviewer subagents for each implementation task
After an implementation subagent finishes, spawn a reviewer subagent to verify the work before checking off the TODO item.

**Reviewer subagent prompt (use verbatim):**

```
You are a neutral, skeptical code reviewer. Your job is to verify that
implementation work matches the approved plan and assigned TODO item.

READ ONLY (do not modify these files):
- Scope: <scope_path>
- Plan: <plan_path>
- TODO: <todo_path>

VERIFY:
- File(s) implemented: <file_paths>

Rules:
1. Read the scope to understand the goals and constraints.
2. Read the plan to understand what should be implemented.
3. Read the TODO to understand the assigned task and execution context.
4. Inspect the implemented files. Check that:
   a. Every plan instruction for these files is implemented exactly as specified.
   b. Nothing extra is implemented beyond what the plan specifies.
   c. The implementation aligns with scope goals and does not violate constraints.
   d. Edge cases mentioned in the plan are handled.
   e. The code is correct and complete.
5. Do not update TODO. Parent owns TODO progress updates.

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

Parent progress update rules:
- If reviewer returns `APPROVED`, parent updates the task to `[x]` and records reviewer subagent ID in the task's `Reviewer:` field.
- If reviewer returns `CHANGES NEEDED`, parent leaves or returns the task to `[~]`, sends the reviewer feedback to the implementation subagent, and re-reviews after fixes.

### Phase 3: Final Verification

#### 4. Full-spec review
After all TODO items are checked off, spawn one final reviewer subagent for a complete end-to-end review:

```
You are a neutral, skeptical code reviewer performing the FINAL verification.

READ ONLY (do not modify these files):
- Scope: <scope_path>
- Plan: <plan_path>
- TODO: <todo_path>

The TODO claims all tasks are complete. Verify this is true by:
1. Reading the scope and confirming every requirement is satisfied.
2. Reading the plan and confirming every instruction is implemented.
3. Reading the TODO and confirming every task is complete and reviewer-verified.
4. Checking that no scope constraint is violated.
5. Checking that no non-goal was accidentally implemented.
6. Running any build, lint, or test commands specified in the plan.

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
2. **Parent owns TODO updates.** Execution and review subagents never modify SCOPE, PLAN, or TODO.
3. **No task is done without review.** Every implementation change must be verified by a neutral reviewer subagent.
4. **Reviewers are neutral.** Give them only file paths. No extra context, no hints, no nudging.
5. **Reviewers find problems, never suggest fixes.** Their output is a list of discrepancies, period.

## Pitfalls
- Do NOT create TODO during execution.
- Do NOT ask execution agents to update TODO.
- Do NOT let execution agents review TODO alignment before working.
- Do NOT reinterpret TODO ordering or parallelism; follow approved TODO exactly.
- Do NOT skip the reviewer. Even "trivial" changes must be reviewed.
- Do NOT spawn a reviewer that also wrote the code. Reviewers must be fresh subagents.
- Do NOT check off TODO items based on implementation subagent self-report alone. Always verify through reviewer.
- Do NOT implement anything not in the plan. If you discover a gap, surface it to the user—do not improvise.
- Do NOT modify scope, plan, or TODO outside the defined process. They are the contract.
- If reviewer and implementer disagree, prefer the reviewer. The reviewer's job is to enforce the contract.

## Verification
- TODO existed before execution.
- Parent performed all TODO progress updates.
- No execution or review subagent modified SCOPE, PLAN, or TODO.
- All TODO items are `[x]` with reviewer verification.
- Final reviewer returned PASS with no caveats.
- All build/lint/test commands pass (verified by final reviewer).
- No scope violations, no plan deviations.
