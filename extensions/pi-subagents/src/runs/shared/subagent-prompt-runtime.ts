import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
export const CHILD_SUBAGENT_SYSTEM_LINE = "You are a Pi subagent controlled by another Pi agent.";

export function rewriteSubagentPrompt(prompt: string): string {
	if (prompt.includes(CHILD_SUBAGENT_SYSTEM_LINE)) return prompt;
	return `${CHILD_SUBAGENT_SYSTEM_LINE}\n\n${prompt}`;
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		const rewritten = rewriteSubagentPrompt(event.systemPrompt);
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
