import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_INTERCOM_SESSION_NAME_ENV =
	"PI_SUBAGENT_INTERCOM_SESSION_NAME";
export const SUBAGENT_RESULT_PATH_ENV = "PI_SUBAGENT_RESULT_PATH";
export const CHILD_SUBAGENT_SYSTEM_LINE =
	"You are a Pi subagent controlled by another Pi agent.";

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

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
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
