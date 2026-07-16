# Agentmemory for Pi

A namespaced, managed integration for [Agentmemory](https://github.com/rohitg00/agentmemory). It connects to an existing service or automatically starts one shared, persistent local daemon, then provides explicit health, search, and save tools plus bounded automatic recall and settled-turn capture.

## Install and update

Install this extension only through the repository's unpinned root git package:

```sh
pi install git:github.com/tasercake/pi-extensions
pi update --all
```

Git installs with an `@tag` or `@commit`, and version-pinned npm installs, do not advance when `pi update --all` runs. Do not manually copy the upstream integration and do not use `npx` for normal startup.

## Capabilities

- `agentmemory_health` checks availability and demand-starts an eligible local service.
- `agentmemory_search` searches project or all historical records.
- `agentmemory_save` stores project or global durable context.
- `/agentmemory-status` performs a fresh non-starting probe and reports safe diagnostics.
- Before each agent run, bounded project-scoped memory is recalled and fenced as untrusted historical data.
- At `agent_settled`, completed user/final-assistant text pairs are captured with deterministic retry deduplication.

The extension deliberately has no `memory_search`, `memory_save`, or `memory_health` aliases. Hermes memory keeps its `memory_search` tool regardless of extension load order; Agentmemory is always addressed through the namespaced `agentmemory_*` tools. Memory is historical context, not authority.

## Environment configuration

Configuration is process-environment only. No project file is read.

| Variable | Default | Behavior |
|---|---|---|
| `AGENTMEMORY_URL` | `http://localhost:3111` | Root Agentmemory endpoint. Only `http:`/`https:` URLs without credentials, query, fragment, or non-root path are accepted. |
| `AGENTMEMORY_SECRET` | unset | Exact bearer secret. Empty means unset. It is never logged or persisted. |
| `AGENTMEMORY_REQUIRE_HTTPS` | unset | `1`/`true` enforces HTTPS for a secret; `0`/`false` cannot weaken secure defaults. |
| `PI_AGENTMEMORY_ALLOW_INSECURE_HTTP` | `0` | `1`/`true` explicitly permits a secret over non-loopback HTTP and emits one warning. It never enables remote autostart. |
| `PI_AGENTMEMORY_AUTOSTART` | `1` | `0`/`false` disables managed startup; probes and tools remain available. |
| `PI_AGENTMEMORY_AUTO_RECALL` | `1` | `0`/`false` disables automatic recall. |
| `PI_AGENTMEMORY_AUTO_CAPTURE` | `1` | `0`/`false` disables settled-turn capture. |

Booleans accept only case-insensitive `1`, `true`, `0`, or `false`. Malformed values and URLs are reported as configuration errors and are never replaced with localhost defaults.

## Privacy and scope

**Automatic recall and automatic capture are on by default.** To opt out before first use, set `PI_AGENTMEMORY_AUTO_RECALL=0` and/or `PI_AGENTMEMORY_AUTO_CAPTURE=0` before starting Pi.

Capture sends only bounded user-visible text and final assistant text. It excludes thinking, images, tool arguments and results, system prompts, secrets, and full session files. Recall and capture use the stable Pi session ID and `ctx.cwd` for both project and cwd. `agentmemory_search` supports `scope: "project" | "all"`; `agentmemory_save` supports `scope: "project" | "global"`.

Recalled server text is control-stripped, angle-bracket escaped, bounded, and enclosed in an explicit untrusted-memory fence. Current user requests, repository files, and current tool evidence override recalled memory.

## Daemon lifecycle and diagnostics

Managed startup applies only to a root-path `http:` URL whose exact normalized hostname is `localhost`, `127.0.0.1`, or `::1`. One detached launcher coordinates startup across Pi processes with an atomic filesystem lock, stale-owner recovery, runtime PID records, and a 45-second readiness deadline. A recognized unauthorized, degraded, critical, or foreign listener suppresses spawning. Remote HTTP/HTTPS endpoints and URLs with paths are probed only.

A daemon started here is host-scoped and persistent. `/reload`, `/new`, `/resume`, `/fork`, Pi shutdown, and Pi exit never stop it. Pi shutdown drains only its private capture queue and cancels session-owned requests/timers. Use Agentmemory's own administrative command when you intentionally want to stop the shared service.

State is under:

```text
~/.agentmemory/pi-extension/<endpoint-sha256-prefix>/
```

Directories use private `0700` permissions and files use `0600` on POSIX. `agentmemory.log` is bounded to 1 MiB, with one prior 1 MiB `agentmemory.log.1` backup. Sensitive-looking daemon lines are replaced wholesale. `/agentmemory-status` reports the exact log path, toggles, health classification, managed/external PID state, bounded queue counts, and safe last errors.

A reusable service must satisfy both:

1. unauthenticated `GET /agentmemory/livez`: HTTP 200, `service: "agentmemory"`, `status: "ok"`;
2. authenticated `GET /agentmemory/health`: HTTP 200, `service: "agentmemory"`, top-level `status: "healthy"`.

A 401/403 is reported as unauthorized. `degraded` and `critical` are unhealthy. Wrong service/shape is foreign. Connection failure is unreachable. None of these are presented as an empty search result.

## First run, platforms, and remediation

The launcher invokes the package-resolved CLI script directly with the current Node executable, ignored stdin, piped non-TTY output, and a private state-directory cwd. There is no shell lookup, prompt, second terminal, or `npx`. Managed startup requires Node 20 or newer and an upstream-supported Agentmemory runtime. Agentmemory 0.9.27 automatically installs its pinned iii-engine on supported macOS/Linux architectures. Windows needs an already compatible iii binary or upstream Docker opt-in because the upstream CLI does not auto-extract its Windows zip. Unsupported or missing prerequisites fail within the startup deadline; Pi continues and the private log explains the failure.

For manual diagnosis or intentional administration, invoke the package-resolved Agentmemory CLI conceptually as:

```text
agentmemory status
agentmemory doctor
agentmemory stop
```

These are remediation/administration actions, not normal startup steps. `/agentmemory-status` identifies the log first.

## Attribution

This extension adapts the official Agentmemory Pi integration and security behavior from `rohitg00/agentmemory` commit `93ae9bc04f3ab5042f982aaadf11f1e3f5137531`, under Apache-2.0. The runtime is deliberately pinned to `@agentmemory/agentmemory` **0.9.27**. See [NOTICE](NOTICE) and [LICENSE](LICENSE). This project is not endorsed by the upstream authors.
