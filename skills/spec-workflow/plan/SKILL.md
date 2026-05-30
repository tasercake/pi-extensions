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
   code, reading docs) to identify potential blockers, edge cases, risks, and
   constraints that the scope may imply but not explicitly state.
5. Scope-aligned. Every item in your plan must trace back to a specific
   requirement or goal in the scope. Nothing extra. Nothing missing.

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

Replace `<scope_path>` with the actual scope file path and `<plan_path>` with a path like `docs/specs/<feature-slug>/PLAN.md`.

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
- If verdict is **APPROVED** with no caveats: Plan is done. Proceed to step 4.
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

#### 4. Finalize
When APPROVED:
- Write-protect the plan: `chmod 444 <plan_path>`
- Report: "Plan approved by reviewer. Ready for execution. Run `spec-execute` next. The plan file is now immutable."

## Pitfalls
- Do NOT give the reviewer any extra context. The whole point is that the plan must stand alone. If you explain things to the reviewer, the plan isn't self-contained.
- Do NOT accept a qualified approval ("approved but..."). It must be an unqualified APPROVED.
- Do NOT let the planner add things not in the scope. The reviewer will catch this.
- Do NOT modify the scope during planning. It is frozen.
- The reviewer only finds problems, never suggests solutions. Keep it that way.
- If the planner keeps missing, the scope might be ambiguous. Surface this to the user rather than looping forever.

## Verification
- Reviewer verdict is unqualified APPROVED
- Every scope requirement traces to at least one plan item (verified by reviewer)
- No plan item exists that doesn't trace to a scope requirement (verified by reviewer)
- Plan file is write-protected (`chmod 444`)
