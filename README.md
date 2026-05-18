# pi-extensions

Public Pi extensions by `tasercake`.

## Extensions

### context-safety

Protects Pi sessions from context explosions:

- spills oversized tool results to private JSON files and inserts a compact notice instead
- blocks oversized raw `@file` references above 16 KiB from being inlined
- quarantines oversized messages before they reach provider context

Default thresholds:

- tool result text: 32 KiB
- tool result details: 32 KiB
- raw `@file`: 16 KiB
- message/context quarantine: 64 KiB

Spills are written under:

```text
~/.pi/agent/spills/context-safety/<session-id>/
```

## Install

```bash
pi install git:github.com/tasercake/pi-extensions
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/tasercake/pi-extensions"
  ]
}
```

## Development

Extension source:

```text
extensions/context-safety/index.ts
```
