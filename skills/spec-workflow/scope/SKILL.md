---
name: spec-scope
description: Write an ultra-concise, feature-level scope document from a refined idea. This is the last step where the user actively intervenes—after the scope is frozen, the agent takes over fully autonomously.
version: 1
created: 2026-05-30
---

## When to Use

Invoke after a feature idea is clear and ready to be formalized. Usually follows `spec-brainstorm`, but can be invoked directly if the idea is already crisp.

Do NOT use this skill if:
- A scope document already exists for this feature (scope is write-once)
- The idea is still vague—run `spec-brainstorm` first

## Procedure

### 1. Choose the scope file path
Decide on a file path for the scope document. Convention: `docs/specs/<feature-slug>/SCOPE.md`. Confirm with the user, then create the directory.

### 2. Write the scope document
Write a scope document with these **mandatory** sections. Nothing more, nothing less.

```markdown
# <Feature Name> — Scope

## Motivation
_1-3 sentences. Why are we building this? What problem does it solve? Who benefits?_

## Goals
_Bullet list. What does success look like? Concrete, measurable outcomes._

## Requirements
_Bullet list. Feature-level requirements ONLY. No implementation details._
_Each requirement must be a testable statement about what the system DOES._

## Restrictions
_Bullet list. External constraints we cannot change: platform limitations,_
_API rate limits, legal requirements, organizational policies, technical boundaries._

## Constraints
_Bullet list. User-defined constraints: budget, timeline, technology choices,_
_performance targets, compatibility requirements, design principles._

## Non-Goals / Out of Scope
_Bullet list. Things we are explicitly NOT doing. Prevents scope creep._
_Be specific: "Support for X" not "Don't over-engineer."_
```

### 3. Rules for the scope document
- **NO implementation details.** No mention of classes, functions, files, algorithms, data structures, libraries, or code patterns. Requirements describe WHAT, not HOW.
- **Every requirement must be testable.** Can someone verify whether it's met?
- **Be concise.** Each requirement is 1-2 sentences max. The entire document should fit on one screen.
- **Be exhaustive.** If it's not in the scope, it doesn't exist. The plan and execution agents will read NOTHING else.
- **Avoid ambiguity.** No "should," "could," "might." Use "must" and "will not."

### 4. Present for user review
Show the scope document to the user. Say explicitly:

> This is the scope document. Review it carefully—**this is your last chance to intervene.**
> After you approve the scope, it becomes immutable. The agent will take over
> fully autonomously from here: planning, reviewing, implementing, verifying.
> Everything that follows will be derived from this document alone.
>
> Reply with "scope approved" or your changes.

### 5. Freeze the scope
When the user says "scope approved" (or explicit equivalent):
- Write-protect the file: `chmod 444 <path>/SCOPE.md`
- Reply: "Scope frozen. Ready for planning. Run `spec-plan` next. The scope file is now immutable."

## Pitfalls
- Do NOT add implementation details. If you find yourself writing about a database, API endpoint, or file structure, stop—that belongs in the plan.
- Do NOT write requirements that are impossible to test.
- Do NOT skip the "Non-Goals" section. Being explicit about what's excluded is as important as what's included.
- Do NOT proceed to planning until the user explicitly approves. This is their last checkpoint.
- Do NOT modify the scope after freezing. It is immutable.

## Verification
- All sections present: Motivation, Goals, Requirements, Restrictions, Constraints, Non-Goals
- No implementation details anywhere in the document
- Every requirement is testable
- User has explicitly approved ("scope approved" or equivalent)
- File is write-protected (`chmod 444`)
