import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ARG_LIMIT = 8000;
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"subagent-prompt-runtime.ts",
);
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV =
	"PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_RESULT_PATH_ENV = "PI_SUBAGENT_RESULT_PATH";

interface BuildPiArgsInput {
	baseArgs: string[];
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	sessionId?: string;
	model?: string;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	runId?: string;
	resultPath?: string;
}

interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

export function applyThinkingSuffix(
	model: string | undefined,
): string | undefined {
	return model;
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = [...input.baseArgs];

	if (input.sessionFile) {
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		args.push("--session", input.sessionFile);
	} else if (input.sessionId) {
		if (!input.sessionDir)
			throw new Error("sessionDir is required when sessionId is provided");
		fs.mkdirSync(input.sessionDir, { recursive: true });
		args.push("--session", input.sessionId, "--session-dir", input.sessionDir);
	} else {
		if (!input.sessionEnabled) args.push("--no-session");
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	if (input.model) args.push("--model", input.model);

	// Add only the minimal runtime extension. Do not disable normal extensions,
	// skills, tools, MCP direct tools, or project context.
	args.push("--extension", PROMPT_RUNTIME_EXTENSION_PATH);

	let tempDir: string | undefined;
	if (input.task.length > TASK_ARG_LIMIT) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	if (input.intercomSessionName)
		env.PI_SUBAGENT_INTERCOM_SESSION_NAME = input.intercomSessionName;
	if (input.orchestratorIntercomTarget)
		env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
	if (input.runId) env[SUBAGENT_RUN_ID_ENV] = input.runId;
	if (input.resultPath) env[SUBAGENT_RESULT_PATH_ENV] = input.resultPath;
	return { args, env, tempDir };
}

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}
