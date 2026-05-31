---
name: spec-plan
description: Generate a concrete implementation plan from a frozen scope, then loop a skeptical reviewer subagent until the plan is fully aligned with zero ambiguity. The plan must be detailed enough that a naive execution agent with no external context can implement it verbatim.
version: 1
created: 2026-05-30
---

## When to Use

Invoke after `spec-scope` is frozen and the user has said "scope approved." This is the first fully autonomous phase—the user does not intervene.

Prerequisites:
- Scope file exists, is immutable, and is approved
- User has said "scope approved" or equivalent

## Procedure

### Phase 1: Planning

#### 1. Spawn the planner subagent
Spawn a subagent with the following prompt (use verbatim):

```
You are a senior software engineer writing an implementation plan.

The scope document is at: <scope_path>

Read the scope document. You must now write a concrete implementation plan
that achieves every goal and satisfies every requirement in the scope,
respecting all restrictions and constraints, while avoiding all non-goals.

YOUR PLAN MUST BE:
1. Fully self-contained. A naive execution agent with NO other context must be
   able to read your plan and execute it verbatim to produce a correct implementation.
2. Exhaustively detailed. Account for every requirement in the scope. Name
   specific files, functions, types, data structures, error conditions, edge
   cases, and testing strategies.
3. Unambiguous. Precisely specify what to build, where to put it, what it
   depends on, and how to verify correctness. No "should" or "could" — only "must."
4. Research-backed. Use all tools at your disposal (web search, reading existing
   code, reading docs, calling grep/LSP to find exact locations) to identify
   potential blockers, edge cases, risks, and constraints that the scope may
   imply but not explicitly state.
5. Scope-aligned. Every item in your plan must trace back to a specific
   requirement or goal in the scope. Nothing extra. Nothing missing.
6. VERIFIED. Every claim about code behavior, existing functions, line numbers,
   file paths, or API signatures must be verified against actual source during
   planning. Use grep, read, LSP navigation — do NOT guess. Do NOT write
   approximate line numbers (~1281). Do NOT write "implementer should check" —
   the plan IS the final word. If a question cannot be resolved during planning,
   state it as a concrete risk with a specific gate step, not an open task.

YOUR PLAN DOCUMENT STRUCTURE:
## Implementation Plan
### Architecture Overview
_Brief description of the technical approach (1-3 paragraphs)._

### File-by-File Implementation
_For each file to be created or modified:_
- **<path>** — What goes in this file. Key types, functions, exports. Edge cases handled.
  Trace back to scope requirements.

### Dependencies
_Libraries, services, or systems needed. Version constraints._

### Testing Strategy
_How each requirement is verified. Specific test cases._

### Risks & Mitigations
_Things that could go wrong and how the plan handles them._

### Implementation Order
_Phased order of work. Dependencies between phases._

### Verification Checklist
_How to confirm the plan is fully executed and matches the scope._

Write the plan to: <plan_path>
```

Replace `<scope_path>` with the actual scope file path and `<plan_path>` with `.spec/<slug>/PLAN.md`, where `<slug>` matches the approved scope directory.

### Phase 2: Review

#### 2. Spawn the reviewer subagent
When the planner completes, spawn a reviewer subagent with the following prompt (use verbatim). **Give the reviewer ONLY the file paths. No additional context, no hints, no summaries, no nudging.**

```
You are a skeptical, hyper-critical code reviewer. Your sole job is to find
problems, not to be nice.

Two files exist:
- Scope: <scope_path>
- Plan: <plan_path>

Your task: Determine whether the plan is FULLY aligned with the scope.

Read BOTH files carefully. The plan must:
1. Cover EVERY requirement in the scope. If a scope requirement has no
   corresponding plan item, that is a FAILURE.
2. Contain NOTHING beyond the scope. Any plan item that doesn't trace back to a
   specific scope requirement is scope creep — that is a FAILURE.
3. Be UNAMBIGUOUS. Every plan instruction must be specific enough that someone
   with no prior context can execute it without asking questions. Vague
   language ("add appropriate error handling," "implement as needed") is a FAILURE.
4. Respect ALL restrictions and constraints from the scope.
5. Avoid ALL non-goals / out-of-scope items from the scope.
6. Be complete. Edge cases, error conditions, and testing must be accounted for.

Respond in exactly this format:

VERDICT: [APPROVED | CHANGES NEEDED]

If APPROVED:
- Confirm that every scope requirement is covered, nothing extra exists, and
  the plan is unambiguous. No caveats, no qualifiers. "Fully satisfied."

If CHANGES NEEDED:
- List every specific gap, ambiguity, or misalignment.
- Cite the exact scope requirement or plan item involved.
- Group into: MISSING (scope requirement not covered), EXTRA (plan item not in scope),
  AMBIGUOUS (plan item too vague to execute), or MISALIGNED (plan contradicts scope).
- Do NOT suggest fixes. Only identify problems.
```

Replace `<scope_path>` and `<plan_path>` with actual paths.

### Phase 3: Iterate

#### 3. Evaluate the review
- If verdict is **APPROVED** with no caveats: Plan is done. Proceed to Phase 4.
- If verdict is **CHANGES NEEDED**: Feed the reviewer's feedback back to the planner subagent. Say:

```
Your plan was reviewed. Here's the feedback. Address every item and rewrite
the plan. The review is below:

<reviewer feedback verbatim>
```

Then re-spawn the planner to rewrite the plan, and then re-spawn the reviewer. Loop until APPROVED.

**IMPORTANT RULES FOR THE LOOP:**
- Never give the reviewer extra context. Always only file paths.
- Never give the planner extra hints beyond the reviewer's raw feedback.
- The loop continues until the reviewer says APPROVED with ZERO caveats. Not "approved but...", not "approved with minor notes." Pure, unqualified APPROVED.
- If the loop goes beyond 5 iterations, report to the user with the latest feedback and ask how to proceed.

### Phase 4: TODO Generation

TODO generation begins only after the plan-reviewer subagent returns an unqualified `APPROVED` verdict. No manual user intervention occurs between PLAN approval and TODO generation.

Spawn a separate TODO author subagent. The TODO author must be distinct from the PLAN author and PLAN reviewer by role/prompt; it must not critique, fix, or rewrite PLAN content.

Use this TODO author prompt verbatim:

```
You are a TODO author converting an approved implementation plan into an execution checklist.

Read-only inputs:
- Scope: <scope_path>
- Approved Plan: <plan_path>

Output:
- TODO: <todo_path>

Your task: Create TODO.md as a concise progress checklist for executing the approved PLAN.

Rules:
1. Treat the PLAN as approved and immutable. Do not critique it, improve it, fix it, or add work not present in it.
2. Use PLAN as the source of work-detail truth. Use SCOPE only as a guardrail against obvious scope creep or weirdness.
3. Define the precise execution sequence, phase ordering, dependencies, and allowed parallelism.
4. Reference PLAN sections/items instead of duplicating detailed PLAN content.
5. Make each task checkable and granular enough for one implementation subagent assignment.
6. Mark every task `[ ]` initially. Do not mark anything in progress or done.
7. Do not create any files other than <todo_path>.

Required TODO format:
# <Feature Name> — TODO

## Ownership
- Parent agent owns this file and is the only actor allowed to update progress checkboxes or reviewer fields.
- Execution agents and review agents must treat SCOPE, PLAN, and TODO as read-only.
- TODO is the source of progress truth. PLAN is the source of work-detail truth. SCOPE is the source of goal/constraint truth.

## Legend
- `[ ]` — Not started
- `[~]` — In progress; parent assigned this task to an execution subagent
- `[x]` — Done; implementation completed and reviewer approved

## Execution Rules
- Execute phases in listed order.
- Tasks within a phase may run in parallel only when explicitly listed as parallel-safe.
- Tasks across phases must not run in parallel.
- Execution agents must follow the referenced PLAN items exactly and must not derive, rewrite, reorganize, or reinterpret TODO.

## Tasks
### Phase 1: <phase name>
Parallelism: <allowed parallelism for this phase>
Dependencies: <prior phases or tasks that must be complete first>
- [ ] **TASK-ID-001**: <short action>; PLAN reference: `<section or bullet name>`; Files: `<path(s)>`; Reviewer: pending
```

Replace placeholders with actual artifact paths when spawning the TODO author. Use `<todo_path>` as `.spec/<slug>/TODO.md`.

### Phase 5: TODO Review

Spawn a separate TODO reviewer subagent after the TODO author completes. The TODO reviewer must receive only file paths, no summaries, hints, or nudging.

Use this TODO reviewer prompt verbatim:

```
You are a skeptical TODO reviewer. Your sole job is to verify that TODO.md faithfully converts the approved PLAN into an execution checklist.

Three files exist:
- Scope: <scope_path>
- Approved Plan: <plan_path>
- TODO: <todo_path>

Read all three files carefully. Use PLAN as the primary source of truth. Use SCOPE only as a secondary guard against weirdness or scope creep.

Verify:
1. TODO covers every implementation item and verification item from PLAN.
2. TODO contains no work beyond PLAN.
3. TODO references PLAN sections/items instead of duplicating detailed PLAN content.
4. TODO defines precise execution sequence, phase ordering, dependencies, and allowed parallelism.
5. TODO states that parent owns progress updates and execution/review agents treat SCOPE, PLAN, and TODO as read-only.
6. TODO is usable as the progress checklist without requiring execution agents to derive, rewrite, reorganize, or reinterpret tasks.

Respond in exactly this format:

VERDICT: [APPROVED | CHANGES NEEDED]

If APPROVED:
- Confirm that TODO faithfully converts PLAN into an execution checklist, contains no extra work, and has unambiguous ordering/ownership. No caveats, no qualifiers. "Fully satisfied."

If CHANGES NEEDED:
- List every specific gap, ambiguity, or misalignment.
- Cite the exact PLAN item and, when relevant, the SCOPE requirement involved.
- Group into: MISSING (PLAN item not represented), EXTRA (TODO item not in PLAN), AMBIGUOUS (ordering, dependency, ownership, or parallelism unclear), or MISALIGNED (TODO contradicts PLAN or SCOPE).
- Do NOT suggest fixes. Only identify problems.
```

Add a TODO review iteration loop:
- If verdict is `APPROVED` with no caveats, TODO is approved.
- If verdict is `CHANGES NEEDED`, feed the reviewer feedback back to the TODO author with exactly:

```
Your TODO was reviewed. Here's the feedback. Address every item and rewrite TODO.md. The review is below:

<reviewer feedback verbatim>
```

Re-run the TODO reviewer. Loop until unqualified `APPROVED`.

### Phase 6: Finalize

Finalize must run only after both PLAN and TODO have unqualified `APPROVED` verdicts.

When APPROVED:
- Write-protect the plan: `chmod 444 <plan_path>`
- Do not chmod TODO read-only because TODO remains mutable for progress tracking.
- Report: "PLAN is approved and immutable. TODO is approved and ready for execution. Execution can start with `spec-execute`."

## Pitfalls
- Do NOT give the reviewer any extra context. The whole point is that the plan must stand alone. If you explain things to the reviewer, the plan isn't self-contained.
- Do NOT accept a qualified approval ("approved but..."). It must be an unqualified APPROVED.
- Do NOT generate TODO before PLAN receives unqualified approval.
- Do NOT let the TODO author critique or fix PLAN quality.
- Do NOT accept qualified TODO approval.
- Do NOT write-protect TODO.
- Do NOT let the planner add things not in the scope. The reviewer will catch this.
- Do NOT modify the scope during planning. It is frozen.
- The reviewer only finds problems, never suggests solutions. Keep it that way.
- Do NOT leave open implementer tasks in the plan. Every claim about code behavior must be verified against actual source during planning — grep, read, trace call paths, find exact line numbers. Do NOT write "implementer should check" or "verify before implementation" — the plan IS the verification. If a question cannot be answered during planning, it is a risk with a concrete gate, not an open task for the executor.
- Do NOT use approximate line numbers (`~1281`). Find exact line numbers with grep or LSP before writing them into the plan. If line numbers may shift, cite the function/symbol name instead.
- Use `.spec/<slug>/PLAN.md` and `.spec/<slug>/TODO.md` for planning artifacts.

## Verification
- PLAN reviewer verdict is unqualified APPROVED
- TODO reviewer verdict is unqualified APPROVED
- Every scope requirement traces to at least one plan item (verified by PLAN reviewer)
- No plan item exists that doesn't trace to a scope requirement (verified by PLAN reviewer)
- TODO is located at `.spec/<slug>/TODO.md`
- TODO faithfully references PLAN sections/items instead of duplicating detailed PLAN content
- TODO defines execution sequence, dependencies, phase ordering, allowed parallelism, and ownership
- PLAN file is write-protected (`chmod 444`)
- TODO file is mutable for parent-owned progress tracking
