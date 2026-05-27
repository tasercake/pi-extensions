/** Minimal recursive Pi subagent extension surface. */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createForkContextResolver } from "../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import {
	checkSubagentDepth,
	getSubagentDepthEnv,
	resolveCurrentMaxSubagentDepth,
} from "../shared/types.ts";
import { getPiSpawnCommand } from "../runs/shared/pi-spawn.ts";
import { buildPiArgs, cleanupTempDir } from "../runs/shared/pi-args.ts";
import {
	GetSubagentStatusParams,
	ListSubagentsParams,
	SpawnSubagentParams,
	type GetSubagentStatusParamsLike,
	type SpawnSubagentParamsLike,
} from "./schemas.ts";

interface ToolDetails {
	id?: string;
	running?: boolean;
	result?: string;
	error?: string;
	subagents?: Array<{ id: string; running: boolean }>;
}

type OutputMode = "inline" | "file";

interface PersistedSubagentRecord {
	id: string;
	parentSessionId: string;
	cwd: string;
	taskPreview: string;
	keepContext: boolean;
	timeout: number;
	outputMode: OutputMode;
	model?: string;
	running: boolean;
	pid?: number;
	sessionFile?: string;
	outputFile?: string;
	stdoutFile: string;
	stderrFile: string;
	result?: string;
	error?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	timeoutAt?: number;
	timeoutNotified?: boolean;
	pendingTimeoutNotice?: boolean;
	timeoutNotifyError?: string;
	timeoutNotifiedAt?: number;
	completionNotificationPending?: boolean;
	notifiedCompletion?: boolean;
	pendingCompletionNotice?: boolean;
	notifyError?: string;
	notifiedAt?: number;
	cohortFinalNotified?: boolean;
}

interface StoreFile {
	records: PersistedSubagentRecord[];
}

const STORE_ROOT = path.join(os.homedir(), ".pi", "agent", "subagents-minimal");
const DEFAULT_TIMEOUT_SECONDS = 3600;
const runningChildren = new Map<string, ChildProcess>();

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || "session";
}

function parentSessionId(ctx: ExtensionContext): string {
	return (
		resolveCurrentSessionId(ctx.sessionManager) ??
		(ctx.sessionManager.getSessionFile?.()
			? path.basename(ctx.sessionManager.getSessionFile()!, ".jsonl")
			: undefined) ??
		"unknown-parent"
	);
}

function parentDir(parentId: string): string {
	return path.join(STORE_ROOT, safeName(parentId));
}

function storePath(parentId: string): string {
	return path.join(parentDir(parentId), "subagents.json");
}

function readStore(parentId: string): StoreFile {
	const file = storePath(parentId);
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as StoreFile;
	} catch {
		return { records: [] };
	}
}

function writeStore(parentId: string, store: StoreFile): void {
	const file = storePath(parentId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function upsertRecord(record: PersistedSubagentRecord): void {
	const store = readStore(record.parentSessionId);
	const idx = store.records.findIndex((r) => r.id === record.id);
	if (idx === -1) store.records.push(record);
	else store.records[idx] = record;
	writeStore(record.parentSessionId, store);
}

function findRecord(
	parentId: string,
	id: string,
): PersistedSubagentRecord | undefined {
	return readStore(parentId).records.find(
		(r) => r.id === id || r.id.startsWith(id),
	);
}

function updateRecordFields(
	parentId: string,
	id: string,
	mutate: (record: PersistedSubagentRecord) => void,
): PersistedSubagentRecord | undefined {
	const store = readStore(parentId);
	const idx = store.records.findIndex((r) => r.id === id);
	if (idx === -1) return undefined;
	const record = store.records[idx];
	mutate(record);
	record.updatedAt = Date.now();
	writeStore(parentId, store);
	return record;
}

function markCompletionNoticePending(
	record: PersistedSubagentRecord,
	error?: unknown,
): PersistedSubagentRecord {
	return (
		updateRecordFields(record.parentSessionId, record.id, (latest) => {
			latest.pendingCompletionNotice = true;
			latest.completionNotificationPending = true;
			if (error !== undefined)
				latest.notifyError = error instanceof Error ? error.message : String(error);
		}) ?? record
	);
}

function markCompletionNoticeSent(
	record: PersistedSubagentRecord,
): PersistedSubagentRecord {
	return (
		updateRecordFields(record.parentSessionId, record.id, (latest) => {
			latest.notifiedCompletion = true;
			latest.pendingCompletionNotice = false;
			latest.completionNotificationPending = false;
			delete latest.notifyError;
			latest.notifiedAt = Date.now();
		}) ?? record
	);
}

function markTimeoutNoticePending(
	record: PersistedSubagentRecord,
	error?: unknown,
): PersistedSubagentRecord {
	return (
		updateRecordFields(record.parentSessionId, record.id, (latest) => {
			latest.pendingTimeoutNotice = true;
			latest.timeoutNotified = false;
			if (error !== undefined)
				latest.timeoutNotifyError = error instanceof Error ? error.message : String(error);
		}) ?? record
	);
}

function markTimeoutNoticeSent(
	record: PersistedSubagentRecord,
): PersistedSubagentRecord {
	return (
		updateRecordFields(record.parentSessionId, record.id, (latest) => {
			latest.timeoutNotified = true;
			latest.pendingTimeoutNotice = false;
			delete latest.timeoutNotifyError;
			latest.timeoutNotifiedAt = Date.now();
		}) ?? record
	);
}

function markTimeoutNoticeSkipped(
	record: PersistedSubagentRecord,
): PersistedSubagentRecord {
	return (
		updateRecordFields(record.parentSessionId, record.id, (latest) => {
			latest.pendingTimeoutNotice = false;
			delete latest.timeoutNotifyError;
		}) ?? record
	);
}

function isPidRunning(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function extractTextFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const p = part as { text?: unknown; content?: unknown; type?: unknown };
			if (typeof p.text === "string") return p.text;
			if (typeof p.content === "string") return p.content;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractFinalOutput(stdout: string): string {
	const rawLines: string[] = [];
	let lastAssistant = "";
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				message?: { role?: string; content?: unknown; errorMessage?: string };
			};
			if (event.message?.role === "assistant") {
				const text = extractTextFromMessageContent(event.message.content);
				if (text.trim()) lastAssistant = text.trim();
			}
		} catch {
			rawLines.push(line);
		}
	}
	return lastAssistant || rawLines.join("\n").trim();
}

function refreshRecordFromDisk(
	record: PersistedSubagentRecord,
): PersistedSubagentRecord {
	if (record.running && !isPidRunning(record.pid)) {
		const stdout = fs.existsSync(record.stdoutFile)
			? fs.readFileSync(record.stdoutFile, "utf-8")
			: "";
		const stderr = fs.existsSync(record.stderrFile)
			? fs.readFileSync(record.stderrFile, "utf-8")
			: "";
		const finalOutput = extractFinalOutput(stdout);
		record.running = false;
		record.updatedAt = Date.now();
		record.completedAt ??= Date.now();
		if (stderr.trim() && !finalOutput) record.error = stderr.trim();
		if (record.outputMode === "file") {
			if (finalOutput && record.outputFile)
				fs.writeFileSync(record.outputFile, `${finalOutput}\n`, {
					mode: 0o600,
				});
			record.result = record.outputFile;
		} else {
			record.result = finalOutput;
		}
		upsertRecord(record);
	}
	return record;
}

function resultForRecord(record: PersistedSubagentRecord): string | undefined {
	return record.outputMode === "file" ? record.outputFile : record.result;
}

function subagentSessionId(record: PersistedSubagentRecord): string | undefined {
	if (!record.sessionFile || !fs.existsSync(record.sessionFile)) return undefined;
	for (const line of fs.readFileSync(record.sessionFile, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; id?: unknown };
			if (event.type === "session" && typeof event.id === "string") return event.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function timeoutMessage(record: PersistedSubagentRecord): string {
	const details = [
		`Subagent ${record.id} timed out after ${record.timeout}s; still running; not killed`,
	];
	const sessionId = subagentSessionId(record);
	if (sessionId) details.push(`sessionId=${sessionId}`);
	if (record.pid) details.push(`pid=${record.pid}`);
	return `${details.join("; ")}.`;
}

function formatStatus(
	record: PersistedSubagentRecord,
): AgentToolResult<ToolDetails> {
	const refreshed = refreshRecordFromDisk(record);
	const result = resultForRecord(refreshed);
	const timedOut = Boolean(refreshed.timeoutAt);
	const timedOutMessage = timedOut ? timeoutMessage(refreshed) : undefined;
	const doNotPollNotice = refreshed.running
		? "Do not poll for the result. You will be notified when the subagent completes."
		: undefined;
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(
					{
						id: refreshed.id,
						running: refreshed.running,
						...(result ? { result } : {}),
						...(timedOut
							? { timedOut: true, timeoutAt: refreshed.timeoutAt, timeoutMessage: timedOutMessage }
							: {}),
						...(refreshed.error ? { error: refreshed.error } : {}),
					},
					null,
					2,
				),
			},
			...(doNotPollNotice
				? [{ type: "text" as const, text: doNotPollNotice }]
				: []),
		],
		details: {
			id: refreshed.id,
			running: refreshed.running,
			...(result ? { result } : {}),
			...(timedOut
				? { timedOut: true, timeoutAt: refreshed.timeoutAt, timeoutMessage: timedOutMessage }
				: {}),
			...(refreshed.error ? { error: refreshed.error } : {}),
		},
	};
}

function childDir(parentId: string, id: string): string {
	return path.join(parentDir(parentId), id);
}

function makeRecord(
	ctx: ExtensionContext,
	params: SpawnSubagentParamsLike,
	id: string,
): PersistedSubagentRecord {
	const parentId = parentSessionId(ctx);
	const dir = childDir(parentId, id);
	fs.mkdirSync(dir, { recursive: true });
	return {
		id,
		parentSessionId: parentId,
		cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
		taskPreview: params.task.slice(0, 500),
		keepContext: params.keepContext,
		timeout: params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
		outputMode: params.outputMode,
		...(params.model ? { model: params.model } : {}),
		running: false,
		sessionFile: path.join(dir, "session.jsonl"),
		outputFile: path.join(dir, "result.md"),
		stdoutFile: path.join(dir, "stdout.log"),
		stderrFile: path.join(dir, "stderr.log"),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function buildArgsForRecord(
	ctx: ExtensionContext,
	record: PersistedSubagentRecord,
	task: string,
): {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
} {
	let sessionFile = record.sessionFile;
	if (record.keepContext) {
		const resolver = createForkContextResolver(ctx.sessionManager, "fork");
		sessionFile = resolver.sessionFileForIndex(0) ?? sessionFile;
		record.sessionFile = sessionFile;
	}
	return buildPiArgs({
		baseArgs: [],
		task,
		sessionEnabled: true,
		sessionFile,
		model: record.model,
		intercomSessionName: `subagent-${record.id}`,
		runId: record.id,
	});
}

function completionMessage(record: PersistedSubagentRecord): string {
	return [
		`Subagent ${record.id} completed.`,
		`Call get_subagent_status({ id: "${record.id}" }) to retrieve the result.`,
	].join("\n");
}

function notifyCompletion(
	pi: ExtensionAPI,
	record: PersistedSubagentRecord,
	options: { markPendingBeforeSend?: boolean } = {},
): boolean {
	const pendingRecord = options.markPendingBeforeSend === false
		? record
		: markCompletionNoticePending(record);
	const parentId = pendingRecord.parentSessionId;
	const store = readStore(parentId);
	const cohort = store.records.filter(
		(r) => r.createdAt >= pendingRecord.createdAt - 60_000 && !r.cohortFinalNotified,
	);
	const active = cohort.filter((r) => refreshRecordFromDisk(r).running);
	const completed = cohort.filter((r) => !refreshRecordFromDisk(r).running);
	const parts = completionMessage(pendingRecord).split("\n");
	const finalCohort = active.length === 0 && cohort.length > 1;
	if (active.length > 0) {
		parts.splice(
			1,
			0,
			`${completed.length} out of ${cohort.length} subagents have completed. You will be notified when all complete.`,
		);
	} else if (finalCohort) {
		parts.splice(1, 0, `All ${cohort.length} subagents have completed.`);
	}
	try {
		pi.sendMessage(
			{ customType: "subagent-notify", content: parts.join("\n"), display: true },
			{ triggerTurn: true },
		);
	} catch (error) {
		if (finalCohort) {
			for (const r of cohort) markCompletionNoticePending(r, error);
		} else {
			markCompletionNoticePending(pendingRecord, error);
		}
		return false;
	}
	if (finalCohort) {
		for (const r of cohort) markCompletionNoticeSent(r);
		for (const r of cohort) {
			updateRecordFields(parentId, r.id, (latest) => {
				latest.cohortFinalNotified = true;
			});
		}
	} else {
		markCompletionNoticeSent(pendingRecord);
	}
	return true;
}

function notifyCompletionBestEffort(
	pi: ExtensionAPI,
	record: PersistedSubagentRecord,
	options: { markPendingBeforeSend?: boolean } = {},
): boolean {
	try {
		return notifyCompletion(pi, record, options);
	} catch (error) {
		try {
			markCompletionNoticePending(record, error);
		} catch {
			// Notification bookkeeping is best-effort; never turn child success
			// into child failure because the parent notification path failed.
		}
		return false;
	}
}

function retryPendingCompletionNotices(
	pi: ExtensionAPI,
	parentId: string,
): void {
	const records = readStore(parentId).records;
	for (const record of records) {
		const refreshed = refreshRecordFromDisk(record);
		if (
			!refreshed.running &&
			(refreshed.pendingCompletionNotice || refreshed.completionNotificationPending) &&
			!refreshed.notifiedCompletion
		) {
			notifyCompletionBestEffort(pi, refreshed);
		}
	}
}

function retryPendingTimeoutNotices(
	pi: ExtensionAPI,
	parentId: string,
): void {
	const records = readStore(parentId).records;
	for (const record of records) {
		const refreshed = refreshRecordFromDisk(record);
		if (!refreshed.timeoutAt) continue;
		if (!refreshed.running) {
			if (refreshed.pendingTimeoutNotice) markTimeoutNoticeSkipped(refreshed);
			continue;
		}
		if (refreshed.pendingTimeoutNotice && !refreshed.timeoutNotified) {
			notifyTimeout(pi, refreshed);
		}
	}
}

function retryPendingNotices(
	pi: ExtensionAPI,
	parentId: string,
): void {
	retryPendingTimeoutNotices(pi, parentId);
	retryPendingCompletionNotices(pi, parentId);
}

function markTimedOut(
	record: PersistedSubagentRecord,
	queueNotice = true,
): PersistedSubagentRecord {
	const latest = findRecord(record.parentSessionId, record.id) ?? record;
	const refreshed = refreshRecordFromDisk(latest);
	if (!refreshed.running) {
		if (refreshed.pendingTimeoutNotice) return markTimeoutNoticeSkipped(refreshed);
		return refreshed;
	}
	if (!refreshed.timeoutAt) refreshed.timeoutAt = Date.now();
	if (queueNotice && !refreshed.timeoutNotified) refreshed.pendingTimeoutNotice = true;
	refreshed.updatedAt = Date.now();
	upsertRecord(refreshed);
	return refreshed;
}

function notifyTimeout(
	pi: ExtensionAPI,
	record: PersistedSubagentRecord,
): boolean {
	const timedOut = markTimedOut(record);
	if (!timedOut.running || !timedOut.timeoutAt || timedOut.timeoutNotified) return false;
	try {
		pi.sendMessage(
			{
				customType: "subagent-notify",
				content: timeoutMessage(timedOut),
				display: true,
			},
			{ triggerTurn: true },
		);
	} catch (error) {
		markTimeoutNoticePending(timedOut, error);
		return false;
	}
	markTimeoutNoticeSent(timedOut);
	return true;
}

function startTimeoutTimer(
	pi: ExtensionAPI,
	record: PersistedSubagentRecord,
	notify: boolean,
): NodeJS.Timeout {
	return setTimeout(() => {
		if (notify) notifyTimeout(pi, record);
		else markTimedOut(record, false);
	}, record.timeout * 1000);
}

async function runChild(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	record: PersistedSubagentRecord,
	task: string,
	notify = false,
): Promise<PersistedSubagentRecord> {
	const depth = checkSubagentDepth();
	if (depth.blocked)
		throw new Error(
			`Subagent recursion depth exceeded: depth ${depth.depth} >= max ${depth.maxDepth}.`,
		);
	const built = buildArgsForRecord(ctx, record, task);
	upsertRecord(record);
	const spawnSpec = getPiSpawnCommand(built.args);
	const stdoutStream = fs.createWriteStream(record.stdoutFile, { flags: "a" });
	const stderrStream = fs.createWriteStream(record.stderrFile, { flags: "a" });
	const env = {
		...process.env,
		...built.env,
		...getSubagentDepthEnv(resolveCurrentMaxSubagentDepth()),
	};
	const child = spawn(spawnSpec.command, spawnSpec.args, {
		cwd: record.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	record.pid = child.pid;
	record.running = true;
	record.updatedAt = Date.now();
	upsertRecord(record);
	runningChildren.set(record.id, child);
	child.stdout.pipe(stdoutStream);
	child.stderr.pipe(stderrStream);
	const finished = await new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) => {
		child.on("close", (code, signal) => resolve({ code, signal }));
		child.on("error", (error) => {
			record.error = error instanceof Error ? error.message : String(error);
			resolve({ code: 1, signal: null });
		});
	});
	await Promise.all([
		new Promise<void>((resolve) => stdoutStream.end(resolve)),
		new Promise<void>((resolve) => stderrStream.end(resolve)),
	]);
	runningChildren.delete(record.id);
	cleanupTempDir(built.tempDir);
	const stdout = fs.existsSync(record.stdoutFile)
		? fs.readFileSync(record.stdoutFile, "utf-8")
		: "";
	const stderr = fs.existsSync(record.stderrFile)
		? fs.readFileSync(record.stderrFile, "utf-8")
		: "";
	const finalOutput = extractFinalOutput(stdout);
	const latest = findRecord(record.parentSessionId, record.id);
	if (latest?.timeoutAt) record.timeoutAt = latest.timeoutAt;
	if (latest?.timeoutNotified) record.timeoutNotified = latest.timeoutNotified;
	record.running = false;
	record.completedAt = Date.now();
	record.updatedAt = Date.now();
	if (finished.code !== 0 && !record.error)
		record.error =
			stderr.trim() ||
			`Subagent exited with code ${finished.code}${finished.signal ? ` (${finished.signal})` : ""}`;
	if (record.outputMode === "file") {
		fs.writeFileSync(record.outputFile!, `${finalOutput}\n`, { mode: 0o600 });
		record.result = record.outputFile;
	} else {
		record.result = finalOutput;
	}
	upsertRecord(record);
	if (notify) notifyCompletionBestEffort(pi, record);
	return record;
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	const spawnTool: ToolDefinition<typeof SpawnSubagentParams, ToolDetails> = {
		name: "spawn_subagent",
		label: "Spawn subagent",
		description:
			"Spawn a child Pi subagent for one task. timeout is optional and measured in seconds (default 3600 = 1 hour). When async is true, this returns immediately, allowing the parent to spawn multiple concurrent subagents by calling spawn_subagent multiple times. Do not kill subagents autonomously to enforce timeout; the parent will be informed when timeout expires. Give a healthy timeout margin above expected runtime because subagent execution may be wildly unpredictable.",
		parameters: SpawnSubagentParams,
		async execute(
			id,
			params: SpawnSubagentParamsLike,
			_signal: AbortSignal,
			_onUpdate: ((result: AgentToolResult<ToolDetails>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			retryPendingNotices(pi, parentSessionId(ctx));
			const record = makeRecord(ctx, params, id);
			if (params.async) {
				const childPromise = runChild(pi, ctx, record, params.task, true);
				const timeoutTimer = startTimeoutTimer(pi, record, true);
				void childPromise
					.catch((error) => {
						record.running = false;
						record.error = error instanceof Error ? error.message : String(error);
						record.updatedAt = Date.now();
						record.completedAt = Date.now();
						upsertRecord(record);
						notifyCompletionBestEffort(pi, record, { markPendingBeforeSend: false });
					})
					.finally(() => clearTimeout(timeoutTimer));
				return {
					content: [
						{
							type: "text",
							text: `Spawned subagent ${record.id}. You will be notified when this subagent completes. You can also call get_subagent_status({ id: "${record.id}" }) to retrieve the result.`,
						},
					],
					details: { id: record.id, running: true },
				};
			}
			let timeoutTimer: NodeJS.Timeout | undefined;
			const childPromise = runChild(pi, ctx, record, params.task, false).finally(() => {
				if (timeoutTimer) clearTimeout(timeoutTimer);
			});
			const timeoutPromise = new Promise<PersistedSubagentRecord>((resolve) => {
				timeoutTimer = setTimeout(
					() => resolve(markTimedOut(record, false)),
					record.timeout * 1000,
				);
			});
			const completed = await Promise.race([childPromise, timeoutPromise]);
			return formatStatus(completed);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("spawn_subagent "))}${args.async ? theme.fg("warning", "async") : "blocking"} ${theme.fg("accent", args.outputMode ?? "inline")}`,
				0,
				0,
			);
		},
	};

	const statusTool: ToolDefinition<
		typeof GetSubagentStatusParams,
		ToolDetails
	> = {
		name: "get_subagent_status",
		label: "Get subagent status",
		description:
			"Get the status and result (or result file path) for a subagent. If the subagent is still running, the response will instruct you not to poll.",
		parameters: GetSubagentStatusParams,
		execute(
			_toolCallId: string,
			params: GetSubagentStatusParamsLike,
			_signal: AbortSignal,
			_onUpdate: ((result: AgentToolResult<ToolDetails>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const parentId = parentSessionId(ctx);
			retryPendingNotices(pi, parentId);
			const record = findRecord(parentId, params.id);
			if (!record) throw new Error(`Unknown subagent id: ${params.id}`);
			return formatStatus(record);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("get_subagent_status "))}${theme.fg("accent", args.id)}`,
				0,
				0,
			);
		},
	};

	const listTool: ToolDefinition<typeof ListSubagentsParams, ToolDetails> = {
		name: "list_subagents",
		label: "List subagents",
		description:
			"List subagents for the current parent session. Data is persisted on disk across session restarts.",
		parameters: ListSubagentsParams,
		execute(
			_toolCallId: string,
			_params: Record<string, never>,
			_signal: AbortSignal,
			_onUpdate: ((result: AgentToolResult<ToolDetails>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const parentId = parentSessionId(ctx);
			retryPendingNotices(pi, parentId);
			const records = readStore(parentId).records.map((r) =>
				refreshRecordFromDisk(r),
			);
			const subagents = records.map((r) => ({ id: r.id, running: r.running }));
			return {
				content: [{ type: "text", text: JSON.stringify(subagents, null, 2) }],
				details: { subagents },
			};
		},
		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("list_subagents")),
				0,
				0,
			);
		},
	};

	pi.registerTool(spawnTool);
	pi.registerTool(statusTool);
	pi.registerTool(listTool);
}
