---
name: spec-brainstorm
description: Optional preliminary phase for spec-driven development. Takes a raw idea, conducts feasibility research, and pressure-tests it with tough questions before scoping begins.
version: 1
created: 2026-05-30
---

## When to Use

Invoke when the user has a rough idea or feature concept and wants it sharpened before committing to a formal scope. This is an **optional** precursor to `spec-scope`. Skip if the user already has a crisp, well-defined feature specification.

Do NOT use this skill if:
- The user explicitly says they already know what they want
- A scope document already exists
- The user asks to go directly to scoping

## Procedure

### 1. Receive the idea
Ask the user to describe the idea in their own words. Don't constrain them. Capture the raw input verbatim.

### 2. Conduct preliminary research
Use all available tools to research the idea:
- **Web search**: Find if similar solutions exist, what the state of the art is, what pitfalls others have hit
- **Read relevant docs**: If the idea touches known technologies, read their docs for constraints and capabilities
- **Check existing codebase**: If working in an existing project, inspect relevant modules for compatibility, constraints, or prior art

### 3. Pressure-test with tough questions
Interrogate the idea ruthlessly. Ask at minimum these categories of questions:

| Category | Example questions |
|---|---|
| Necessity | Is this actually needed? What problem does it solve? Who is the user? What happens if we don't build it? |
| Feasibility | Is this technically possible? What are the hard parts? What could make it impossible? |
| Scope creep | What might this grow into? What will people ask for next? Where is the natural boundary? |
| Edge cases | What happens when inputs are empty/malformed/extreme? What breaks at scale? |
| Security / safety | What could go wrong? What are the abuse vectors? |
| Dependencies | What does this depend on? What systems must exist first? What external services are needed? |
| Cost / complexity | How hard is this to build? How hard to maintain? How hard to debug when broken? |
| Alternatives | Is there a simpler way to achieve the same outcome? Could an existing tool solve 80% of it? |

### 4. Synthesize findings
Summarize the research and answers. Produce a crisp summary that:
- Restates the refined idea in 1-2 sentences
- Lists the top 3-5 risks or open questions
- Recommends whether to proceed to scoping, and if so, what the scope should cover
- Notes anything that was explicitly ruled out during the discussion

### 5. Hand off or terminate
If the user decides to proceed, tell them:
> Ready to scope. Run the `spec-scope` skill next.

If the user decides against it, document why and stop.

## Pitfalls
- Don't rush to scoping. The point of this phase is to kill bad ideas early.
- Don't go easy on the questions. Being nice here leads to pain later.
- Don't start designing solutions. This phase is about the problem, not the solution.
- Don't skip web research. Someone has almost certainly tried something similar before.

## Verification
- The refined idea is clear enough that a scope doc could be written from it
- Major risks are identified and acknowledged
- The user explicitly confirms they want to proceed to scoping (or not)
