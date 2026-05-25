# pi-context-usage

A Pi extension that exposes context-window analysis as a model-callable tool.

This package is adapted from `@mrclrchtr/supi-context@1.8.0`, but it intentionally **does not** register the `/supi-context` slash command. Instead it registers one tool the LLM can call:

- `get_context_usage` — returns a short text summary followed by structured JSON containing the same context analysis data.

## Install locally

```bash
pi install ./extensions/context-usage
```

After editing the source, run `/reload` in Pi.

## Tool

### `get_context_usage`

Parameters:

- `full` (optional boolean) — include all extracted guideline bullets. Defaults to `false`.

The response includes:

- model name and context-window size
- estimated or provider-scaled total token usage
- token usage by category: system prompt, user messages, assistant messages, tool calls, tool results, other, autocompact buffer, and free space
- system-prompt breakdown for instruction files, context files, skills, guidelines, tool snippets, and append text
- injected subdirectory context files from `supi-claude-md`
- active skills and token costs
- active tool definitions and token costs
- guideline source attribution
- compaction summary when older turns were summarized
- extra provider sections registered through the shared SuPi context-provider registry

## Notes

- The extension caches `systemPromptOptions` from Pi's `before_agent_start` event for more accurate prompt composition analysis.
- When exact usage data is unavailable, it falls back to estimated token counts and includes an approximation note.
- No slash commands are registered by this package.

## Source

- `src/context.ts` — tool registration and cached prompt-option handling
- `src/analysis.ts` — token accounting and report data
- `src/format.ts` — original formatted report helpers retained from upstream
- `src/prompt-inference.ts` — prompt-option inference helpers
- `src/renderer.ts` — original renderer retained from upstream, not registered by this package
- `src/utils.ts` — token formatting helpers
