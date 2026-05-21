# PLAN.md second-pass review

Remaining material gaps requiring PLAN.md edits:

1. **MCP direct-tool restriction env is not covered.**
   - Current `src/runs/shared/pi-args.ts` sets `MCP_DIRECT_TOOLS` from agent config, and sets `MCP_DIRECT_TOOLS="__none__"` when no direct tools are configured.
   - Scope forbids hiding/restricting tools except recursion depth. PLAN Phase 4 forbids `--tools`, `--no-skills`, and `--no-extensions`, but should also explicitly remove agent-derived `mcpDirectTools` plumbing and avoid setting `MCP_DIRECT_TOOLS` to a restrictive value. Add tests that child env does not constrain MCP/direct tools.

2. **Existing attention/control and completion-guard functionality needs an explicit keep-or-delete decision.**
   - Current code has nontrivial met/control behavior: `active_long_running`, `needs_attention`, failed mutating-tool escalation, and completion mutation guard (`src/runs/shared/subagent-control.ts`, `src/runs/shared/completion-guard.ts`, foreground/async runner integrations).
   - Scope summary says preserve/refactor existing met functionality, but PLAN mostly removes the public `control` param and only discusses steering/status/async completion. Add a phase item defining which of this monitoring/guard functionality is preserved in the four-tool runtime, how labels become constant `subagent` instead of agent names, and which old control instructions/status strings must be updated away from `subagent({ action: ... })`.

3. **`install.mjs` still exposes old public surface and is not in the docs/manifests phase.**
   - Current installer help/completion text advertises the old `subagent` mega-tool and agents (`install.mjs` lines around the final “Tool added: subagent - Delegate tasks to agents...” message).
   - PLAN Phase 12 should include `extensions/pi-subagents/install.mjs`: update help/output to the four tools, remove old agent wording, and decide whether the hardcoded upstream repo/install path remains appropriate for this vendored package.
