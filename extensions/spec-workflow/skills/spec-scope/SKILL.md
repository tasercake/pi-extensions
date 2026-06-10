---
name: spec-scope
description: Write an ultra-concise, feature-level scope document based on a user idea. Use when asked to write a scope/spec document.
version: 1
created: 2026-05-30
---

## Procedure

### 1. Choose the scope file path
Decide on a file path for the scope document. Convention: `.spec/<slug>/SCOPE.md`, where `<slug>` is the feature slug selected for the workflow. Use the same slug for PLAN and TODO in later phases. Create the directory if it doesn't exist, and ensure `.spec` is added to `.gitignore` if not already present.

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
_Bullet list. Existing system-level restrictions that we cannot change and have no control over: platform limitations, API rate limits, legal requirements, organizational policies, technical boundaries._

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
- Do NOT add implementation details. If you find yourself writing about a database, API endpoint, or file structure, stop — that belongs in the plan.
- Do NOT fabricate items that have not been explicitly stated or approved for inclusion by the user.
- Do NOT write requirements that are impossible to test.
- Do NOT skip the "Non-Goals" section. Being explicit about what's excluded is as important as what's included.
- Do NOT proceed to planning until the user explicitly approves. This is their last checkpoint.
- Do NOT modify the scope after freezing. It is immutable.

## Verification
- No implementation details anywhere in the document
- Every requirement is testable
- User has explicitly approved ("scope approved" or equivalent)
- File is write-protected (`chmod 444`)
