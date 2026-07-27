import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { Socket } from "node:net";
import * as path from "node:path";

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

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as { type?: unknown; text?: unknown; content?: unknown };
			if (value.type === "text" && typeof value.text === "string") {
				return value.text;
			}
			if (typeof value.content === "string") return value.content;
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function hasNonEmptyResult(resultPath: string): boolean {
	try {
		return fs.statSync(resultPath).size > 0;
	} catch {
		return false;
	}
}

function writeResultIfEmpty(resultPath: string, content: string): void {
	if (!content || hasNonEmptyResult(resultPath)) return;
	fs.mkdirSync(path.dirname(resultPath), { recursive: true });
	const temporaryPath = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
		if (!hasNonEmptyResult(resultPath)) fs.renameSync(temporaryPath, resultPath);
	} finally {
		try {
			fs.rmSync(temporaryPath, { force: true });
		} catch {
			// Atomic result cleanup is best-effort.
		}
	}
}

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

	// Wrap the dedicated pipe as a socket so its libuv handle can be unref'd.
	// EOF still detects parent death while the child is active, but the watcher
	// alone must not keep a successfully settled child process alive.
	const lifeline = new Socket({ fd, readable: true, writable: false });
	let terminating = false;
	const terminate = () => {
		if (terminating) return;
		terminating = true;
		process.kill(process.pid, "SIGTERM");
	};
	lifeline.once("end", terminate);
	lifeline.once("error", terminate);
	lifeline.resume();
	lifeline.unref();
}

// Run at module load time so the watcher is active before any Pi handlers fire.
setupLifelineWatcher();

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	let settledProviderError: string | undefined;
	let exitingForProviderError = false;
	let finalAssistantText = "";

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason !== "error") {
			settledProviderError = undefined;
			const text = extractAssistantText(event.message.content);
			if (text) finalAssistantText = text;
			return;
		}
		settledProviderError =
			event.message.errorMessage?.trim() ||
			`Provider/model request failed for ${event.message.provider}/${event.message.model}.`;
	});

	pi.on("agent_settled", () => {
		if (!settledProviderError || exitingForProviderError) return;
		exitingForProviderError = true;
		const resultPath = process.env[SUBAGENT_RESULT_PATH_ENV]?.trim();
		if (resultPath) {
			try {
				writeResultIfEmpty(resultPath, "(error)\n");
			} catch (error) {
				process.stderr.write(
					`Could not persist provider failure result: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		}
		process.exitCode = 1;
		process.stderr.write(`${settledProviderError}\n`);
		// message_end has been persisted and agent_settled guarantees no retry,
		// compaction, or queued continuation remains. Preserve the provider
		// failure as a prompt nonzero process exit.
		setImmediate(() => process.exit(1));
	});

	pi.on("session_shutdown", () => {
		const resultPath = process.env[SUBAGENT_RESULT_PATH_ENV]?.trim();
		if (!resultPath || !finalAssistantText) return;
		try {
			writeResultIfEmpty(resultPath, `${finalAssistantText}\n`);
		} catch (error) {
			process.stderr.write(
				`Could not persist final subagent result: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
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
