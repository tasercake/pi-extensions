---
name: spec-scope
description: Write an ultra-concise, feature-level scope document based on a user idea. Use when asked to write a scope/spec document.
version: 1
created: 2026-05-30
---

## Procedure

### 1. Choose the scope file path
Decide on a file path for the scope document. Convention: `.spec/<slug>/SCOPE.md`, where `<slug>` is the feature slug selected for the workflow. Use the same slug for PLAN and TODO in later phases. Create the directory if it doesn't exist, and ensure `.spec` is added to `.gitignore` if not already present.

### 2. Write the initial scope document
Write the first scope document as a faithful capture of the user's stated idea. Preserve the user's intent and wording as much as possible. Do **not** infer missing requirements, add clever improvements, or fill gaps from your own judgment.

The initial scope does **not** need to contain every section below. Include only sections that can be meaningfully populated from what the user already stated. Missing sections must be filled through refinement, not invention.

Target these sections by the time scope freezes:

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
- **Be exhaustive by freeze time.** If it's not in the frozen scope, it doesn't exist. The plan and execution agents will read NOTHING else.
- **Avoid ambiguity.** No "should," "could," "might." Use "must" and "will not."
- **Initial scope mirrors the user.** First write must stay as close as possible to what the user actually presented, even if that leaves sections missing.
- **Refinements require user approval.** Agent/subagent discoveries can become questions, but not scope content unless explicitly stated or approved by the user.

### 4. Do cursory exploration
After writing the initial scope, spawn subagents to do cursory exploration of relevant repository context, docs, prior specs, or external facts the scope may depend on. Exploration subagents gather observations, reflect on gaps, brainstorm possible directions, play devil's advocate, and propose questions; they must not rewrite scope or add requirements.

Treat subagent findings as prompts for user discussion, not as scope content. Nothing discovered by subagents enters the scope unless the user explicitly states it or approves it for inclusion.

### 5. Offer refinement loop
Show the initial scope document to the user. If any target sections are missing or thin, directly grill the user with pointed questions and concrete suggestions to fill them meaningfully. Make clear that refinement is optional and can be short, but may also be the longest and most valuable part of the workflow: a deep, involved back-and-forth until the user is satisfied.

During each refinement iteration:
- Spawn subagents to explore relevant context, reflect on the current scope, brainstorm alternatives, and play devil's advocate. Use subagents to reduce conflicts with reality and bring fresh perspective to the problem.
- Ask subagents for observations, risks, gaps, contradictions, non-goal candidates, and pointed questions. Do not ask them to author scope content.
- Only add, remove, or change scope content when the user explicitly states the change or explicitly approves suggested wording for inclusion.
- Keep user-approved ideas, requirements, constraints, restrictions, and non-goals in the scope document.
- Keep unapproved suggestions, assumptions, discoveries, and agent opinions out of the scope document.
- After each user response and subagent pass, update the scope document if needed, show the revised relevant parts or full document, and ask whether to continue refining or freeze.
- The user can approve/freeze at any time by saying "scope approved", "freeze scope", or an explicit equivalent.
- If the user tries to approve/freeze without any refinement, or while most target sections remain missing/thin, pause and warn them exactly once that the scope may be under-specified. Ask for confirmation before freezing. If they confirm, freeze. Do not repeat this warning.
- If the user says to approve/freeze and all target sections are substantially filled, do not ask for confirmation; freeze immediately.

Say explicitly:

> This is the initial scope document, based only on what you stated. I can ask refinement questions to sharpen it, or you can approve/freeze it now.
> During refinement, only items you explicitly state or approve will be added.
> After you approve the scope, it becomes immutable. The agent will take over
> fully autonomously from here: planning, reviewing, implementing, verifying.
> Everything that follows will be derived from this document alone.
>
> Reply with "scope approved" to freeze it, or answer the refinement questions / provide changes.

### 6. Freeze the scope
When the user says "scope approved" (or explicit equivalent):
- If all target sections are substantially filled, freeze immediately.
- If there was no refinement or most target sections are missing/thin, warn exactly once and ask for confirmation before freezing. If the user confirms, freeze even if still under-specified.
- Write-protect the file: `chmod 444 <path>/SCOPE.md`
- Reply: "Scope frozen. Ready for planning. Run `spec-plan` next. The scope file is now immutable."

## Pitfalls
- Do NOT add implementation details. If you find yourself writing about a database, API endpoint, or file structure, stop — that belongs in the plan.
- Do NOT fabricate items that have not been explicitly stated or approved for inclusion by the user.
- Do NOT let subagent findings silently expand scope. Convert findings into questions for the user instead.
- Do NOT skip subagents during refinement iterations; use them for reality checks, fresh perspective, brainstorming, and devil's advocacy.
- Do NOT write requirements that are impossible to test.
- Do NOT invent content just to fill sections. Missing/thin sections should trigger pointed refinement questions instead.
- Do NOT skip the "Non-Goals" section at freeze time unless the user explicitly confirms freezing an under-specified scope after the one-time warning. Being explicit about what's excluded is as important as what's included.
- Do NOT proceed to planning until the user explicitly approves. This is their last checkpoint.
- Do NOT modify the scope after freezing. It is immutable.

## Verification
- Target sections are substantially filled by freeze time, or user confirmed freezing after the one-time under-specified warning
- Initial scope was based only on the user's stated idea and did not invent missing sections
- No implementation details anywhere in the document
- Every requirement is testable
- All refinements were explicitly stated or approved by the user
- User has explicitly approved/frozen ("scope approved" or equivalent)
- File is write-protected (`chmod 444`)
