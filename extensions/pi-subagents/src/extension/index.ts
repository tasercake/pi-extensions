/** Minimal recursive Pi subagent extension surface. */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	checkSubagentDepth,
	getSubagentDepthEnv,
	resolveCurrentMaxSubagentDepth,
} from "../shared/types.ts";
import { getPiSpawnCommand } from "../runs/shared/pi-spawn.ts";
import { buildPiArgs, cleanupTempDir } from "../runs/shared/pi-args.ts";
import { PI_SUBAGENT_LIFELINE_FD } from "../runs/shared/subagent-prompt-runtime.ts";
import {
	SpawnSubagentParams,
	type SpawnSubagentParamsLike,
} from "./schemas.ts";

interface ToolDetails {
	id?: string;
	sessionId?: string;
	sessionFile?: string;
	running?: boolean;
	result?: string;
	resultPath?: string;
	error?: string;
	timedOut?: boolean;
	timeoutAt?: number;
	timeoutMessage?: string;
	model?: string;
	subagents?: Array<{ id: string; running: boolean }>;
}

interface PersistedSubagentRecord {
	id: string;
	parentSessionId: string;
	cwd: string;
	taskPreview: string;
	keepContext?: boolean;
	timeout: number;
	model?: string;
	running: boolean;
	pid?: number;
	sessionDir?: string;
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
	cohortId?: string;
	cohortCreatedAt?: number;
}

interface StoreFile {
	records: PersistedSubagentRecord[];
}

interface ReconcileResult {
	records: PersistedSubagentRecord[];
	active: PersistedSubagentRecord[];
}

interface StartChildHooks {
	onRunning?(record: PersistedSubagentRecord): void;
	onTimeout?(record: PersistedSubagentRecord): void;
	onTerminal?(record: PersistedSubagentRecord): void;
	onSetupFailure?(record: PersistedSubagentRecord, error: unknown): void;
}

const DEFAULT_TIMEOUT_SECONDS = 600;
const runningChildren = new Map<string, ChildProcess>();

// Lifeline pipes keyed by record.id. Each entry holds the parent's end of the
// child's dedicated fd 3 pipe. The parent never writes to it; holding it open
// keeps the child's read end alive. When the parent process dies the kernel
// closes all FDs, the child sees EOF, and self-terminates.
function closeLifeline(recordId: string): void {
	const stream = lifelines.get(recordId);
	if (!stream) return;
	lifelines.delete(recordId);
	try { stream.end(); } catch { /* best-effort */ }
	try { stream.destroy(); } catch { /* best-effort */ }
}

function destroyAllLifelines(): void {
	for (const id of [...lifelines.keys()]) closeLifeline(id);
}

const lifelines = new Map<string, Writable>();
const activeCohorts = new Map<
	string,
	{ id: string; createdAt: number; turnIndex?: number }
>();

function getOrCreateActiveCohort(
	parentId: string,
	turnIndex?: number,
): { id: string; createdAt: number; turnIndex?: number } {
	const existing = activeCohorts.get(parentId);
	if (existing) return existing;
	const cohort = { id: randomUUID(), createdAt: Date.now(), turnIndex };
	activeCohorts.set(parentId, cohort);
	return cohort;
}

function closeActiveCohort(parentId: string): void {
	activeCohorts.delete(parentId);
}

// Widget state: parentId -> latest UI-capable ExtensionContext
const uiParents = new Map<string, ExtensionContext>();
// Dual timers per parent (always unref'd):
// - widget (1Hz): refresh elapsed-time display
// - reconcile (0.2Hz): belt-and-suspenders reconcile for sleep/wake recovery
const widgetTimers = new Map<
	string,
	{ widget: NodeJS.Timeout; reconcile: NodeJS.Timeout }
>();
function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || "session";
}

function getBaseDir(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (sessionFile) {
		const dir = path.dirname(sessionFile);
		const name = path.basename(sessionFile, ".jsonl");
		// Parent is a subagent: session file is .../subagents/<id>/session.jsonl
		// → base dir is its own directory (one level up from session.jsonl)
		if (name === "session") return dir;
		// Parent is a main session: <timestamp>_<uuid>.jsonl in sessions/<cwd>/
		// → sibling directory named after the session file (without .jsonl)
		return path.join(dir, name);
	}
	// Ephemeral parent session — fall back to temp
	return path.join(os.tmpdir(), "pi-subagents", String(Date.now()));
}

function parentSessionId(ctx: ExtensionContext): string {
	return getBaseDir(ctx);
}

function storePath(parentId: string): string {
	return path.join(parentId, "subagents", "subagents.json");
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
				latest.notifyError =
					error instanceof Error ? error.message : String(error);
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
				latest.timeoutNotifyError =
					error instanceof Error ? error.message : String(error);
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

function refreshRecord(record: PersistedSubagentRecord): {
	record: PersistedSubagentRecord;
	changed: boolean;
} {
	if (!record.running || isPidRunning(record.pid)) {
		return { record, changed: false };
	}
	const refreshed: PersistedSubagentRecord = { ...record };
	const stdout = fs.existsSync(refreshed.stdoutFile)
		? fs.readFileSync(refreshed.stdoutFile, "utf-8")
		: "";
	const stderr = fs.existsSync(refreshed.stderrFile)
		? fs.readFileSync(refreshed.stderrFile, "utf-8")
		: "";
	refreshed.running = false;
	refreshed.updatedAt = Date.now();
	refreshed.completedAt ??= Date.now();

	// Check if subagent already wrote to the result file.
	const hasExistingResult =
		refreshed.outputFile &&
		fs.existsSync(refreshed.outputFile) &&
		fs.readFileSync(refreshed.outputFile, "utf-8").trim().length > 0;

	if (!hasExistingResult) {
		const finalOutput = extractFinalOutput(stdout);
		if (finalOutput && refreshed.outputFile) {
			fs.writeFileSync(refreshed.outputFile, `${finalOutput}\n`, {
				mode: 0o600,
			});
		} else if (stderr.trim()) {
			// Subagent produced only stderr, no stdout output.
			if (!refreshed.error) refreshed.error = stderr.trim();
			if (refreshed.outputFile) {
				fs.writeFileSync(refreshed.outputFile, "(error)\n", { mode: 0o600 });
			}
		} else if (refreshed.outputFile) {
			// Edge case: neither stdout nor stderr produced content.
			// Write a placeholder so the parent gets a valid result file.
			fs.writeFileSync(refreshed.outputFile, "(no output)\n", { mode: 0o600 });
		}
	}
	refreshed.result = refreshed.outputFile;
	return { record: refreshed, changed: true };
}

function refreshRecordFromDisk(
	record: PersistedSubagentRecord,
): PersistedSubagentRecord {
	const { record: refreshed, changed } = refreshRecord(record);
	const beforeSessionFile = refreshed.sessionFile;
	if (refreshed.sessionDir) recordDiscoveredSessionFile(refreshed);
	if (changed || refreshed.sessionFile !== beforeSessionFile)
		upsertRecord(refreshed);
	return refreshed;
}

function reconcileStore(parentId: string): ReconcileResult {
	const store = readStore(parentId);
	const refreshedResults = store.records.map((r) => refreshRecord(r));
	const latest = readStore(parentId);
	const latestById = new Map(latest.records.map((r) => [r.id, r]));
	const merged: PersistedSubagentRecord[] = [];
	let anyChanged = false;
	for (const { record: r, changed } of refreshedResults) {
		const existing = latestById.get(r.id);
		if (!existing) {
			merged.push(r);
			if (changed) anyChanged = true;
			continue;
		}
		const result = mergeRecord(existing, r);
		merged.push(result);
		if (changed || JSON.stringify(result) !== JSON.stringify(existing))
			anyChanged = true;
	}
	for (const [id, r] of latestById) {
		if (!refreshedResults.some((ref) => ref.record.id === id)) merged.push(r);
	}
	if (anyChanged) writeStore(parentId, { records: merged });
	const active = merged.filter((r) => r.running === true);
	return { records: merged, active };
}

function mergeRecord(
	latest: PersistedSubagentRecord,
	refreshed: PersistedSubagentRecord,
): PersistedSubagentRecord {
	if (refreshed.running === false && latest.running === true) {
		return applyNotificationFields(latest, refreshed, refreshed);
	}
	if (latest.running === false && refreshed.running === true) {
		return applyNotificationFields(latest, refreshed, latest);
	}
	const base =
		refreshed.updatedAt > latest.updatedAt
			? {
					...latest,
					pid: refreshed.pid ?? latest.pid,
					cwd: refreshed.cwd,
					taskPreview: refreshed.taskPreview,
					timeout: refreshed.timeout,
					model: refreshed.model ?? latest.model,
					running: refreshed.running,
					sessionDir: refreshed.sessionDir ?? latest.sessionDir,
					sessionFile: refreshed.sessionFile ?? latest.sessionFile,
					outputFile: refreshed.outputFile ?? latest.outputFile,
					stdoutFile: refreshed.stdoutFile,
					stderrFile: refreshed.stderrFile,
					result: refreshed.result ?? latest.result,
					error: refreshed.error ?? latest.error,
					createdAt: refreshed.createdAt,
					updatedAt: refreshed.updatedAt,
					completedAt: refreshed.completedAt ?? latest.completedAt,
					timeoutAt: refreshed.timeoutAt ?? latest.timeoutAt,
					cohortId: refreshed.cohortId ?? latest.cohortId,
					cohortCreatedAt:
						refreshed.cohortCreatedAt ?? latest.cohortCreatedAt,
				}
			: latest;
	return applyNotificationFields(latest, refreshed, base);
}

function applyNotificationFields(
	latest: PersistedSubagentRecord,
	refreshed: PersistedSubagentRecord,
	base: PersistedSubagentRecord,
): PersistedSubagentRecord {
	// Avoid reordering keys: only assign fields whose computed value differs
	// from what is already on the base. Otherwise JSON.stringify detects key
	// reordering and triggers spurious reconcile writes that clobber durable
	// notification state.
	const r = base as unknown as Record<string, unknown>;
	function set(key: string, val: unknown): void {
		if (r[key] !== val) r[key] = val;
	}
	set(
		"notifiedCompletion",
		latest.notifiedCompletion || refreshed.notifiedCompletion,
	);
	set("timeoutNotified", latest.timeoutNotified || refreshed.timeoutNotified);
	set(
		"cohortFinalNotified",
		latest.cohortFinalNotified || refreshed.cohortFinalNotified,
	);
	set("notifiedAt", refreshed.notifiedAt ?? latest.notifiedAt);
	set(
		"timeoutNotifiedAt",
		refreshed.timeoutNotifiedAt ?? latest.timeoutNotifiedAt,
	);
	const notifiedCompletion =
		latest.notifiedCompletion || refreshed.notifiedCompletion;
	set(
		"pendingCompletionNotice",
		(latest.pendingCompletionNotice || refreshed.pendingCompletionNotice) &&
			!notifiedCompletion,
	);
	set(
		"completionNotificationPending",
		(latest.completionNotificationPending ||
			refreshed.completionNotificationPending) &&
			!notifiedCompletion,
	);
	const timeoutNotified = latest.timeoutNotified || refreshed.timeoutNotified;
	set(
		"pendingTimeoutNotice",
		(latest.pendingTimeoutNotice || refreshed.pendingTimeoutNotice) &&
			!timeoutNotified,
	);
	set("notifyError", refreshed.notifyError || latest.notifyError);
	set(
		"timeoutNotifyError",
		refreshed.timeoutNotifyError || latest.timeoutNotifyError,
	);
	return r as unknown as PersistedSubagentRecord;
}

function activeRecordsForParent(parentId: string): PersistedSubagentRecord[] {
	return readStore(parentId).records.filter((r) => r.running === true);
}

function widgetRecordsForParent(parentId: string): PersistedSubagentRecord[] {
	const records = readStore(parentId).records;
	const activeCohortIds = new Set(
		records
			.filter((r) => r.running === true && r.cohortId)
			.map((r) => r.cohortId!),
	);
	return records
		.filter((r) => r.running === true || (r.cohortId && activeCohortIds.has(r.cohortId)))
		.sort((a, b) => a.createdAt - b.createdAt);
}

function hasUiWidget(ctx: ExtensionContext): boolean {
	return Boolean(ctx.hasUI && ctx.ui && typeof ctx.ui.setWidget === "function");
}

function safeSetWidget(
	ctx: ExtensionContext,
	key: string,
	lines: string[] | undefined,
): void {
	if (!hasUiWidget(ctx)) return;
	try {
		ctx.ui?.setWidget(key, lines, { placement: "aboveEditor" });
	} catch (_widgetError) {
		// Widget failure must never fail child lifecycle
	}
}

function rememberUiContext(ctx: ExtensionContext): void {
	if (!hasUiWidget(ctx)) return;
	const parentId = parentSessionId(ctx);
	uiParents.set(parentId, ctx);
}

const WIDGET_REFRESH_INTERVAL_MS = 1000; // 1Hz — elapsed-time display
const RECONCILE_INTERVAL_MS = 5000; // 0.2Hz — wake recovery belt-and-suspenders

function scheduleWidgetRefresh(parentId: string): void {
	const ctx = uiParents.get(parentId);
	if (!ctx) return;
	const active = activeRecordsForParent(parentId);
	if (active.length === 0) {
		stopWidgetRefreshIfIdle(parentId);
		return;
	}

	const existing = widgetTimers.get(parentId);
	if (existing) return; // already scheduled

	const widgetTimer = setInterval(() => {
		const freshCtx = uiParents.get(parentId);
		if (!freshCtx) {
			stopWidgetRefreshIfIdle(parentId);
			return;
		}
		renderRunningWidget(freshCtx, parentId);
	}, WIDGET_REFRESH_INTERVAL_MS);
	widgetTimer.unref();

	const reconcileTimer = setInterval(() => {
		const freshCtx = uiParents.get(parentId);
		if (!freshCtx) {
			stopWidgetRefreshIfIdle(parentId);
			return;
		}
		reconcileStore(parentId);
		renderRunningWidget(freshCtx, parentId);
		stopWidgetRefreshIfIdle(parentId);
	}, RECONCILE_INTERVAL_MS);
	reconcileTimer.unref();

	widgetTimers.set(parentId, {
		widget: widgetTimer,
		reconcile: reconcileTimer,
	});
}

function stopWidgetRefreshIfIdle(parentId: string): void {
	const timers = widgetTimers.get(parentId);
	if (!timers) return;
	const active = activeRecordsForParent(parentId);
	if (active.length > 0) return;
	clearInterval(timers.widget);
	clearInterval(timers.reconcile);
	widgetTimers.delete(parentId);
}

function stopAllWidgetRefreshForInstance(): void {
	for (const timers of widgetTimers.values()) {
		clearInterval(timers.widget);
		clearInterval(timers.reconcile);
	}
	widgetTimers.clear();
	uiParents.clear();
}

function renderRunningWidget(ctx: ExtensionContext, parentId: string): void {
	const records = widgetRecordsForParent(parentId);
	const key = runningWidgetKey(parentId);
	if (records.length === 0) {
		safeSetWidget(ctx, key, undefined);
		stopWidgetRefreshIfIdle(parentId);
		return;
	}
	const lines = records.map((r) => formatRunningLine(r));
	safeSetWidget(ctx, key, lines);
}

function maybeRenderRunningWidget(
	ctx: ExtensionContext,
	parentId: string,
): void {
	if (!hasUiWidget(ctx)) return;
	renderRunningWidget(ctx, parentId);
}

function runningWidgetKey(parentId: string): string {
	return `pi-subagents-running:${safeName(parentId)}`;
}

function terminalWidth(): number {
	const columns = process.stdout.columns;
	return Number.isFinite(columns) && columns > 0 ? columns : 80;
}

function visibleLength(text: string): number {
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function fitToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

function sanitizePreview(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatRunningLine(record: PersistedSubagentRecord): string {
	const elapsed = Math.floor((Date.now() - record.createdAt) / 1000);
	const timedOut = Boolean(record.timeoutAt);
	const statusText = record.running
		? timedOut
			? "timed out, still running"
			: `running ${elapsed}s`
		: record.error
			? "failed"
			: "complete";
	const icon = record.running ? "⏳" : record.error ? "✖" : "✓";
	const prefix = `${icon} subagent ${statusText}`;
	const preview = sanitizePreview(record.taskPreview);
	const separator = preview ? " — " : "";
	const available = Math.max(0, terminalWidth() - visibleLength(prefix) - separator.length);
	const line = `${prefix}${separator}${fitToWidth(preview, available)}`;
	return `\x1b[2m${line}\x1b[22m`;
}

function resultForRecord(record: PersistedSubagentRecord): string | undefined {
	return (
		record.outputFile ??
		path.join(childDir(record.parentSessionId, record.id), "result.log")
	);
}

function subagentSessionId(
	record: PersistedSubagentRecord,
): string | undefined {
	if (!record.sessionFile || !fs.existsSync(record.sessionFile))
		return undefined;
	for (const line of fs.readFileSync(record.sessionFile, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; id?: unknown };
			if (event.type === "session" && typeof event.id === "string")
				return event.id;
		} catch {
			// Ignore malformed session log lines.
		}
	}
	return undefined;
}

function timeoutMessage(record: PersistedSubagentRecord): string {
	const details = [
		`Subagent ${record.id} timed out after ${record.timeout}s; still running; not killed`,
	];
	const sessionId = subagentSessionId(record) ?? record.id;
	details.push(`sessionId=${sessionId}`);
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
		? "Do not poll for the result. Do not sleep for the result. You will be notified when the subagent completes."
		: undefined;
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(
					{
						id: refreshed.id,
						sessionId: refreshed.id,
						running: refreshed.running,
						...(result ? { resultPath: result } : {}),
						...(timedOut
							? {
									timedOut: true,
									timeoutAt: refreshed.timeoutAt,
									timeoutMessage: timedOutMessage,
								}
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
			sessionId: refreshed.id,
			running: refreshed.running,
			...(result ? { resultPath: result } : {}),
			...(timedOut
				? {
						timedOut: true,
						timeoutAt: refreshed.timeoutAt,
						timeoutMessage: timedOutMessage,
					}
				: {}),
			...(refreshed.error ? { error: refreshed.error } : {}),
		},
	};
}

function childDir(parentId: string, id: string): string {
	return path.join(parentId, "subagents", id);
}

function discoverManagedSessionFile(
	sessionDir: string,
	id: string,
): string | undefined {
	if (!fs.existsSync(sessionDir)) return undefined;
	const suffix = `_${id}.jsonl`;
	const matches = fs
		.readdirSync(sessionDir)
		.filter((name) => name.endsWith(suffix))
		.sort();
	const latest = matches.at(-1);
	return latest ? path.join(sessionDir, latest) : undefined;
}

function recordDiscoveredSessionFile(record: PersistedSubagentRecord): void {
	if (!record.sessionDir)
		record.sessionDir = childDir(record.parentSessionId, record.id);
	const discovered = discoverManagedSessionFile(record.sessionDir, record.id);
	if (discovered) record.sessionFile = discovered;
}

function makeRecord(
	ctx: ExtensionContext,
	params: SpawnSubagentParamsLike,
): PersistedSubagentRecord {
	const id = randomUUID();
	const parentId = parentSessionId(ctx);
	const dir = childDir(parentId, id);
	const inheritedModel = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	const model = params.model || inheritedModel;
	fs.mkdirSync(dir, { recursive: true });
	return {
		id,
		parentSessionId: parentId,
		cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
		taskPreview: params.task.slice(0, 500),
		timeout: params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
		...(model ? { model } : {}),
		running: false,
		sessionDir: dir,
		outputFile: path.join(dir, "result.log"),
		stdoutFile: path.join(dir, "stdout.log"),
		stderrFile: path.join(dir, "stderr.log"),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function buildArgsForRecord(
	_ctx: ExtensionContext,
	record: PersistedSubagentRecord,
	task: string,
): {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
} {
	record.sessionDir ??= childDir(record.parentSessionId, record.id);
	fs.mkdirSync(record.sessionDir, { recursive: true });
	return buildPiArgs({
		baseArgs: [],
		task,
		sessionEnabled: true,
		sessionDir: record.sessionDir,
		sessionId: record.id,
		model: record.model,
		intercomSessionName: `subagent-${record.id}`,
		runId: record.id,
		resultPath: record.outputFile,
	});
}

function completionMessage(record: PersistedSubagentRecord): string {
	return [
		`Subagent ${record.id} completed.`,
		`Result file: ${record.outputFile}`,
		"You must read the result file at the path above.",
	].join("\n");
}

function shortErrorSummary(error: unknown): string {
	const summary = String(error ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!summary) return "failed";
	const maxLength = 160;
	return summary.length > maxLength
		? `${summary.slice(0, maxLength - 1)}…`
		: summary;
}

function failedCohortEntry(record: PersistedSubagentRecord): string {
	return [
		`- ${record.id}:`,
		`  error: ${shortErrorSummary(record.error)}`,
		`  result: ${record.outputFile}`,
		`  stderr: ${record.stderrFile}`,
	].join("\n");
}

function cohortCompletionMessage(records: PersistedSubagentRecord[]): string {
	const failed = records.filter((r) => r.error);
	if (failed.length === 0) {
		return [
			`All ${records.length} subagents completed successfully.`,
			"Result files:",
			...records.map((r) => `- ${r.id}: ${r.outputFile}`),
			"You must read the result files at the paths above.",
		].join("\n");
	}

	if (failed.length === records.length) {
		return [
			`All ${records.length} subagents finished with errors.`,
			"Subagents:",
			...records.map(failedCohortEntry),
			"You must read stderr logs and result files at the paths above.",
		].join("\n");
	}

	return [
		`${records.length} subagents finished; ${failed.length} failed.`,
		"Subagents:",
		...records.map((r) =>
			r.error ? failedCohortEntry(r) : `- ${r.id}: ${r.outputFile}`,
		),
		"You must read result files at the paths above, and read stderr logs for failures.",
	].join("\n");
}

function completionCohort(
	parentId: string,
	pendingRecord: PersistedSubagentRecord,
): PersistedSubagentRecord[] {
	const store = readStore(parentId);
	if (!pendingRecord.cohortId) {
		const match = store.records.find((r) => r.id === pendingRecord.id);
		return match ? [match] : [pendingRecord];
	}
	const cohort = store.records.filter(
		(r) => r.cohortId === pendingRecord.cohortId && !r.cohortFinalNotified,
	);
	return cohort.length > 0 ? cohort : [pendingRecord];
}

function notifyCompletion(
	pi: ExtensionAPI,
	record: PersistedSubagentRecord,
	options: { markPendingBeforeSend?: boolean } = {},
): boolean {
	const pendingRecord =
		options.markPendingBeforeSend === false
			? record
			: markCompletionNoticePending(record);
	const parentId = pendingRecord.parentSessionId;
	const cohort = completionCohort(parentId, pendingRecord);
	const refreshedCohort = cohort.map(refreshRecordFromDisk);
	const active = refreshedCohort.filter((r) => r.running);
	const finalCohort = active.length === 0 && refreshedCohort.length > 1;
	if (refreshedCohort.length > 1 && !finalCohort) {
		markCompletionNoticeSent(pendingRecord);
		return true;
	}
	let content: string;
	if (refreshedCohort.length === 1) {
		content = completionMessage(pendingRecord);
	} else if (finalCohort) {
		content = cohortCompletionMessage(refreshedCohort);
	} else {
		content = completionMessage(pendingRecord);
	}
	try {
		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display: true,
			},
			{ triggerTurn: true },
		);
	} catch (error) {
		if (finalCohort) {
			for (const r of refreshedCohort) markCompletionNoticePending(r, error);
		} else {
			markCompletionNoticePending(pendingRecord, error);
		}
		return false;
	}
	if (finalCohort) {
		for (const r of refreshedCohort) markCompletionNoticeSent(r);
		for (const r of refreshedCohort) {
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
			(refreshed.pendingCompletionNotice ||
				refreshed.completionNotificationPending) &&
			!refreshed.notifiedCompletion
		) {
			notifyCompletionBestEffort(pi, refreshed);
		}
	}
}

function retryPendingTimeoutNotices(pi: ExtensionAPI, parentId: string): void {
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

function retryPendingNotices(pi: ExtensionAPI, parentId: string): void {
	retryPendingTimeoutNotices(pi, parentId);
	retryPendingCompletionNotices(pi, parentId);
}

function markTimedOut(
	record: PersistedSubagentRecord,
	queueNotice = true,
): PersistedSubagentRecord {
	// Use updateRecordFields for atomic read-modify-write to avoid
	// clobbering a newer terminal state written by the child close handler.
	// WARNING: Do NOT call refreshRecordFromDisk or upsertRecord inside the
	// callback.  The outer updateRecordFields writes the store after the
	// callback returns, so any inner upsert would be immediately clobbered.
	// Instead only check liveness via isPidRunning and conditionally clear
	// pending flags on the record that updateRecordFields will persist.
	const updated = updateRecordFields(
		record.parentSessionId,
		record.id,
		(latest) => {
			// Already terminal (child close handler won): just clear pending
			// timeout flags without re-marking running.
			if (!latest.running) {
				if (latest.pendingTimeoutNotice) {
					latest.pendingTimeoutNotice = false;
					delete latest.timeoutNotifyError;
				}
				return;
			}
			// Verify PID is still alive.  If the PID died but store still
			// says running, mark terminal inline (no separate upsert).
			if (!isPidRunning(latest.pid)) {
				latest.running = false;
				latest.completedAt ??= Date.now();
				if (latest.pendingTimeoutNotice) {
					latest.pendingTimeoutNotice = false;
					delete latest.timeoutNotifyError;
				}
				return;
			}
			if (!latest.timeoutAt) latest.timeoutAt = Date.now();
			if (queueNotice && !latest.timeoutNotified) {
				latest.pendingTimeoutNotice = true;
			}
		},
	);
	if (!updated) return record;
	return updated;
}

function notifyTimeout(
	pi: ExtensionAPI,
	record: PersistedSubagentRecord,
): boolean {
	// Re-read latest from store before sending; skip if already notified.
	// Return true: consistent with notifyCompletion ("did we handle it?").
	const freshLatest = findRecord(record.parentSessionId, record.id);
	if (freshLatest?.timeoutNotified) return true;

	const timedOut = markTimedOut(record);
	if (!timedOut.running || !timedOut.timeoutAt || timedOut.timeoutNotified)
		return false;
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
	const timer = setTimeout(function onSubagentTimeout() {
		if (notify) notifyTimeout(pi, record);
		else markTimedOut(record, false);
	}, record.timeout * 1000);
	timer.unref();
	return timer;
}

function startChild(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	record: PersistedSubagentRecord,
	task: string,
	notify = false,
	hooks?: StartChildHooks,
): { record: PersistedSubagentRecord; done: Promise<PersistedSubagentRecord> } {
	const depth = checkSubagentDepth();
	if (depth.blocked) {
		const error = new Error(
			`Subagent recursion depth exceeded: depth ${depth.depth} >= max ${depth.maxDepth}.`,
		);
		record.running = false;
		record.error = error.message;
		record.completedAt = Date.now();
		record.updatedAt = Date.now();
		upsertRecord(record);
		hooks?.onSetupFailure?.(record, error);
		return { record, done: Promise.reject(error) };
	}

	let child: ChildProcess;
	let stdoutStream: fs.WriteStream;
	let stderrStream: fs.WriteStream;
	const built = buildArgsForRecord(ctx, record, task);

	try {
		upsertRecord(record);
		const spawnSpec = getPiSpawnCommand(built.args);
		stdoutStream = fs.createWriteStream(record.stdoutFile, { flags: "a" });
		stderrStream = fs.createWriteStream(record.stderrFile, { flags: "a" });
		const env = {
			...process.env,
			...built.env,
			...getSubagentDepthEnv(resolveCurrentMaxSubagentDepth()),
		};
		// Keep stdin independent from process ownership. The parent holds its
		// side of the dedicated fd 3 pipe open without writing; the child
		// runtime watches fd 3 for EOF to detect parent death.
		env[PI_SUBAGENT_LIFELINE_FD] = "3";
		child = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: record.cwd,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
			env,
		});
	} catch (error) {
		record.running = false;
		record.error = error instanceof Error ? error.message : String(error);
		record.completedAt = Date.now();
		record.updatedAt = Date.now();
		upsertRecord(record);
		hooks?.onSetupFailure?.(record, error);
		return {
			record,
			done: Promise.reject(
				error instanceof Error ? error : new Error(String(error)),
			),
		};
	}

	record.pid = child.pid;
	record.running = true;
	record.updatedAt = Date.now();
	recordDiscoveredSessionFile(record);
	upsertRecord(record);
	runningChildren.set(record.id, child);
	hooks?.onRunning?.(record);

	if (!child.stdout || !child.stderr) {
		throw new Error("Subagent process stdio pipes were not created.");
	}
	const lifeline = child.stdio[3] as Writable | null;
	if (!lifeline || typeof lifeline.end !== "function") {
		throw new Error("Subagent process lifeline pipe was not created.");
	}
	lifelines.set(record.id, lifeline);
	child.stdout.pipe(stdoutStream);
	child.stderr.pipe(stderrStream);

	const done = new Promise<PersistedSubagentRecord>((resolve) => {
		let finalized = false;

		async function finalizeChild(
			code: number | null,
			signal: NodeJS.Signals | null,
		) {
			if (finalized) return;
			finalized = true;

			await Promise.all([
				new Promise<void>((r) => stdoutStream.end(r)),
				new Promise<void>((r) => stderrStream.end(r)),
			]);

			runningChildren.delete(record.id);
			// Release the lifeline on normal child completion.
			closeLifeline(record.id);
			cleanupTempDir(built.tempDir);

			const stdout = fs.existsSync(record.stdoutFile)
				? fs.readFileSync(record.stdoutFile, "utf-8")
				: "";
			const stderr = fs.existsSync(record.stderrFile)
				? fs.readFileSync(record.stderrFile, "utf-8")
				: "";

			const latest = findRecord(record.parentSessionId, record.id);
			if (latest?.timeoutAt) record.timeoutAt = latest.timeoutAt;
			if (latest?.timeoutNotified)
				record.timeoutNotified = latest.timeoutNotified;

			record.running = false;
			record.completedAt = Date.now();
			record.updatedAt = Date.now();

			if (code !== 0 && !record.error)
				record.error =
					stderr.trim() ||
					`Subagent exited with code ${code}${signal ? ` (${signal})` : ""}`;

			// Check if subagent already wrote to result file
			const hasExistingResult =
				record.outputFile &&
				fs.existsSync(record.outputFile) &&
				fs.readFileSync(record.outputFile, "utf-8").trim().length > 0;

			if (!hasExistingResult) {
				// Subagent did not write to result file — auto-save final output
				const finalOutput = extractFinalOutput(stdout);
				if (finalOutput && record.outputFile) {
					fs.writeFileSync(record.outputFile, `${finalOutput}\n`, {
						mode: 0o600,
					});
				} else if (stderr.trim()) {
					// Subagent produced only stderr, no stdout output.
					if (!record.error) record.error = stderr.trim();
					if (record.outputFile) {
						fs.writeFileSync(record.outputFile, "(error)\n", { mode: 0o600 });
					}
				} else if (record.outputFile) {
					// Edge case: neither stdout nor stderr produced content.
					fs.writeFileSync(record.outputFile, "(no output)\n", { mode: 0o600 });
				}
			}
			record.result = record.outputFile;
			recordDiscoveredSessionFile(record);

			upsertRecord(record);

			if (notify) {
				notifyCompletionBestEffort(pi, record);
			}

			hooks?.onTerminal?.(record);
			resolve(record);
		}

		child.on("close", (code, signal) => finalizeChild(code, signal));
		child.on("error", (error) => {
			if (!record.error) {
				record.error = error instanceof Error ? error.message : String(error);
			}
			finalizeChild(1, null);
		});
	});

	return { record, done };
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	const spawnTool: ToolDefinition<typeof SpawnSubagentParams, ToolDetails> = {
		name: "spawn_subagent",
		label: "Spawn subagent",
		description:
			"Spawn a child Pi subagent for one task. model is an explicit override; omitting it inherits the active parent provider/model. timeout is optional and measured in seconds (default 600 = 10 minutes). This returns immediately, allowing the parent to spawn multiple concurrent subagents by calling spawn_subagent multiple times. Do not kill subagents autonomously to enforce timeout; the parent will be informed when timeout expires. Give a healthy timeout margin above expected runtime because subagent execution may be wildly unpredictable.",
		parameters: SpawnSubagentParams,
		async execute(
			id,
			params: SpawnSubagentParamsLike,
			_signal: AbortSignal,
			_onUpdate: ((result: AgentToolResult<ToolDetails>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			void id;
			const parentId = parentSessionId(ctx);
			retryPendingNotices(pi, parentId);
			rememberUiContext(ctx);
			const record = makeRecord(ctx, params);
			const cohort = getOrCreateActiveCohort(parentId);
			record.cohortId = cohort.id;
			record.cohortCreatedAt = cohort.createdAt;
			const hooks: StartChildHooks = {
				onRunning(_r) {
					rememberUiContext(ctx);
					renderRunningWidget(ctx, parentId);
					scheduleWidgetRefresh(parentId);
				},
				onTimeout(_r) {
					renderRunningWidget(ctx, parentId);
				},
				onTerminal(_r) {
					renderRunningWidget(ctx, parentId);
					stopWidgetRefreshIfIdle(parentId);
				},
				onSetupFailure(_r, _error) {
					renderRunningWidget(ctx, parentId);
					stopWidgetRefreshIfIdle(parentId);
				},
			};
			const started = startChild(pi, ctx, record, params.task, true, hooks);
			const timeoutTimer = startTimeoutTimer(pi, started.record, true);
			void started.done
				.catch((error) => {
					record.running = false;
					record.error =
						error instanceof Error ? error.message : String(error);
					record.updatedAt = Date.now();
					record.completedAt = Date.now();
					upsertRecord(record);
					notifyCompletionBestEffort(pi, record, {
						markPendingBeforeSend: false,
					});
				})
				.catch(() => {})
				.finally(() => clearTimeout(timeoutTimer));
			return {
				content: [
					{
						type: "text",
						text: `Spawned subagent ${started.record.id} using ${started.record.model ?? "Pi's selected model"}. Result will be at: ${started.record.outputFile}. You will be notified when this subagent completes. Do not poll for result. Do not sleep for result. Continue with whatever other work you may have.`,
					},
				],
				details: {
					id: started.record.id,
					running: started.record.running,
					resultPath: started.record.outputFile,
					...(started.record.model ? { model: started.record.model } : {}),
				},
			};
		},
		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("spawn_subagent background")),
				0,
				0,
			);
		},
	};

	pi.registerTool(spawnTool);

	if (typeof pi.on === "function") {
		pi.on("session_start", (_event, ctx) => {
			rememberUiContext(ctx);
			const parentId = parentSessionId(ctx);
			reconcileStore(parentId);
			if (hasUiWidget(ctx)) {
				renderRunningWidget(ctx, parentId);
				scheduleWidgetRefresh(parentId);
			}
			retryPendingNotices(pi, parentId);
		});

		pi.on("agent_end", (_event, ctx) => {
			rememberUiContext(ctx);
			const parentId = parentSessionId(ctx);
			closeActiveCohort(parentId);
			if (hasUiWidget(ctx)) {
				renderRunningWidget(ctx, parentId);
				scheduleWidgetRefresh(parentId);
			}
			// Headless/JSON mode: parent process stays alive naturally because
			// child stdout/stderr pipes to fs.WriteStream keep Node's event loop alive.
			// When all children complete, event loop drains and process exits naturally.
			// IMPORTANT: assumes Pi does NOT call process.exit() after agent_end in
			// headless mode. If that changes, extension needs explicit ref-counting.
			// Do not close stdout: external caller owns stdout lifecycle.
			// pi.sendMessage writes NDJSON to stdout after agent_end while stdout stays open.
		});

		pi.on("session_shutdown", (_event, _ctx) => {
			// Close all lifelines: the owning session is being torn down.
			// This terminates all running children for this parent session.
			destroyAllLifelines();
			// Clear all widget refresh timers to prevent stale UI state across extension instances.
			stopAllWidgetRefreshForInstance();
			activeCohorts.clear();
		});
	}
}
