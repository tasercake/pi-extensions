import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_INTERCOM_SESSION_NAME_ENV =
	"PI_SUBAGENT_INTERCOM_SESSION_NAME";
export const SUBAGENT_RESULT_PATH_ENV = "PI_SUBAGENT_RESULT_PATH";
export const CHILD_SUBAGENT_SYSTEM_LINE =
	"You are a Pi subagent controlled by another Pi agent.";

const RESULT_PATH_MARKER = "Your result file:";

export function rewriteSubagentPrompt(prompt: string): string {
	if (prompt.includes(CHILD_SUBAGENT_SYSTEM_LINE)) return prompt;
	return `${CHILD_SUBAGENT_SYSTEM_LINE}\n\n${prompt}`;
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		const intercomSessionName =
			process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		let rewritten = rewriteSubagentPrompt(event.systemPrompt);

		const resultPath = process.env[SUBAGENT_RESULT_PATH_ENV]?.trim();
		if (resultPath && !rewritten.includes(RESULT_PATH_MARKER)) {
			rewritten = `${rewritten}\n\nYour result file: ${resultPath}\nYou may write your final output to this file at any time using any tool (e.g., write, bash). If you leave the file empty, your final assistant message will be automatically saved there on exit.`;
		}

		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
