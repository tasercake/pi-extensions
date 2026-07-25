import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";

export const SUBAGENT_INTERCOM_SESSION_NAME_ENV =
	"PI_SUBAGENT_INTERCOM_SESSION_NAME";
export const SUBAGENT_RESULT_PATH_ENV = "PI_SUBAGENT_RESULT_PATH";
export const CHILD_SUBAGENT_SYSTEM_LINE =
	"You are a Pi subagent controlled by another Pi agent.";

/** Env var set by the parent when spawning a managed subagent.
 *  Value is the child-side file descriptor number of the anonymous lifeline pipe.
 *  The child watches this fd for EOF; when the parent process dies the kernel
 *  closes the write end and the child detects the EOF to self-terminate. */
export const PI_SUBAGENT_LIFELINE_FD = "PI_SUBAGENT_LIFELINE_FD";

const RESULT_PATH_MARKER = "Your result file:";
const RESULT_PATH_ALIASES = new Set([
	"$PI_SUBAGENT_RESULT_PATH",
	"${PI_SUBAGENT_RESULT_PATH}",
]);
const FILE_TOOL_NAMES = new Set(["write", "edit", "read"]);

export function rewriteSubagentPrompt(prompt: string): string {
	if (prompt.includes(CHILD_SUBAGENT_SYSTEM_LINE)) return prompt;
	return `${CHILD_SUBAGENT_SYSTEM_LINE}\n\n${prompt}`;
}

// ── Lifeline watcher: self-terminate when parent process dies ──

function setupLifelineWatcher(): void {
	const lifelineFdRaw = process.env[PI_SUBAGENT_LIFELINE_FD];
	if (lifelineFdRaw === undefined) return;

	const fd = parseInt(lifelineFdRaw, 10);
	if (!Number.isFinite(fd) || fd < 0) return;

	// Create a read stream on the lifeline fd.  When the parent process
	// dies the kernel closes the write end of the pipe; the child sees EOF
	// and the stream emits 'end' → self-terminate via SIGTERM.
	// We use a dedicated ReadStream (not process.stdin) so we never
	// conflict with whatever Pi may do with its own stdin handling.
	// We use fd option to read directly from the lifeline fd; the path
	// argument is not used when fd is supplied but required by the type.
	const lifeline = fs.createReadStream("", { fd, autoClose: false });
	lifeline.on("end", () => {
		process.kill(process.pid, "SIGTERM");
	});
	lifeline.on("error", () => {
		// If the fd is already closed or invalid, treat as parent death.
		process.kill(process.pid, "SIGTERM");
	});
	// Start flowing so libuv polls the fd for readability/EOF.
	lifeline.resume();
}

// Run at module load time so the watcher is active before any Pi handlers fire.
setupLifelineWatcher();

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	let settledProviderError: string | undefined;
	let exitingForProviderError = false;

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason !== "error") {
			settledProviderError = undefined;
			return;
		}
		settledProviderError =
			event.message.errorMessage?.trim() ||
			`Provider/model request failed for ${event.message.provider}/${event.message.model}.`;
	});

	pi.on("agent_settled", () => {
		if (!settledProviderError || exitingForProviderError) return;
		exitingForProviderError = true;
		process.exitCode = 1;
		process.stderr.write(`${settledProviderError}\n`);
		// message_end has been persisted and agent_settled guarantees no retry,
		// compaction, or queued continuation remains. Force exit because the
		// dedicated parent lifeline intentionally keeps the event loop alive.
		setImmediate(() => process.exit(1));
	});

	pi.on("tool_call", (event) => {
		if (!FILE_TOOL_NAMES.has(event.toolName)) return;
		const resultPath = process.env[SUBAGENT_RESULT_PATH_ENV]?.trim();
		const input = event.input as { path?: unknown };
		if (
			resultPath &&
			typeof input.path === "string" &&
			RESULT_PATH_ALIASES.has(input.path)
		) {
			input.path = resultPath;
		}
	});

	pi.on("before_agent_start", async (event) => {
		const intercomSessionName =
			process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		let rewritten = rewriteSubagentPrompt(event.systemPrompt);

		const resultPath = process.env[SUBAGENT_RESULT_PATH_ENV]?.trim();
		if (resultPath && !rewritten.includes(RESULT_PATH_MARKER)) {
			rewritten = `${rewritten}\n\nYour result file: ${resultPath} (resolved absolute result path)\nPi file tools (\`write\`, \`edit\`, and \`read\`) must receive this literal absolute path as \`path\`; they do not expand shell environment variables. \`PI_SUBAGENT_RESULT_PATH\` contains the same path for shell commands and programs. Use \`$PI_SUBAGENT_RESULT_PATH\` only inside bash/shell commands. If you leave the result file empty, your final assistant message will be automatically saved there on exit.`;
		}

		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
