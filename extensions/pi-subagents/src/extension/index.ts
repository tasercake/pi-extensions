/** Minimal recursive Pi subagent extension surface. */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import {
	checkSubagentDepth,
	getSubagentDepthEnv,
	resolveCurrentMaxSubagentDepth,
} from "../shared/types.ts";
import {
	CappedLogWriter,
	STDERR_LOG_MAX_BYTES,
	STDOUT_LOG_MAX_BYTES,
} from "../runs/shared/capped-log.ts";
import { getPiSpawnCommand } from "../runs/shared/pi-spawn.ts";
import { buildPiArgs, cleanupTempDir } from "../runs/shared/pi-args.ts";

// Keep this child-runtime environment key local. Importing the prompt runtime
// here would execute its child-only fd watcher in the parent extension process.
const PI_SUBAGENT_LIFELINE_FD = "PI_SUBAGENT_LIFELINE_FD";
import {
	GetSubagentStatusParams,
	type GetSubagentStatusParamsLike,
	ListSubagentsParams,
	SpawnSubagentParams,
	type SpawnSubagentParamsLike,
	TailSubagentParams,
	type TailSubagentParamsLike,
} from "./schemas.ts";

interface ToolDetails {
	id?: string;
	sessionId?: string;
	running?: boolean;
	resultPath?: string;
	model?: string;
	error?: string;
	subagents?: Array<{ id: string; running: boolean }>;
	lines?: string[];
}

interface PersistedSubagentRecord {
	id: string;
	parentSessionId: string;
	cwd: string;
	taskPreview: string;
	keepContext?: boolean;
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
	onTerminal?(record: PersistedSubagentRecord): void;
	onSetupFailure?(record: PersistedSubagentRecord, error: unknown): void;
}
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
	return readStore(parentId).records.find((record) => record.id === id);
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

const SESSION_READ_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_LINE_BYTES = 16 * 1024 * 1024;

function hasNonEmptyFile(filePath: string | undefined): boolean {
	if (!filePath) return false;
	try {
		return fs.statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

function readDiagnosticFile(
	filePath: string | undefined,
	label: string,
): { text: string; issue?: string } {
	if (!filePath) return { text: "" };
	try {
		const size = fs.statSync(filePath).size;
		if (size > STDERR_LOG_MAX_BYTES) {
			return {
				text: "",
				issue: `${label} exceeds the ${STDERR_LOG_MAX_BYTES}-byte diagnostic limit: ${filePath}`,
			};
		}
		return { text: fs.readFileSync(filePath, "utf-8") };
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: undefined;
		if (code === "ENOENT") return { text: "" };
		return {
			text: "",
			issue: `Could not read ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function assistantOutputFromSessionLine(line: Buffer): string {
	if (line.length === 0) return "";
	try {
		const event = JSON.parse(line.toString("utf8")) as {
			message?: { role?: string; content?: unknown };
		};
		if (event.message?.role !== "assistant") return "";
		return extractTextFromMessageContent(event.message.content).trim();
	} catch {
		return "";
	}
}

function recoverFinalOutput(record: PersistedSubagentRecord): {
	output: string;
	issue?: string;
} {
	try {
		recordDiscoveredSessionFile(record);
	} catch (error) {
		return {
			output: "",
			issue: `Could not discover child session: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!record.sessionFile) return { output: "" };

	let fd: number | undefined;
	let lastAssistant = "";
	let issue: string | undefined;
	let pieces: Buffer[] = [];
	let pendingBytes = 0;
	let droppingOversizedLine = false;
	const chunk = Buffer.allocUnsafe(SESSION_READ_CHUNK_BYTES);

	const append = (part: Buffer) => {
		if (part.length === 0 || droppingOversizedLine) return;
		if (pendingBytes + part.length > MAX_SESSION_LINE_BYTES) {
			droppingOversizedLine = true;
			pieces = [];
			pendingBytes = 0;
			issue ??= `Child session contains a line larger than ${MAX_SESSION_LINE_BYTES} bytes: ${record.sessionFile}`;
			return;
		}
		pieces.push(Buffer.from(part));
		pendingBytes += part.length;
	};
	const finishLine = () => {
		if (!droppingOversizedLine) {
			const output = assistantOutputFromSessionLine(Buffer.concat(pieces, pendingBytes));
			if (output) lastAssistant = output;
		}
		pieces = [];
		pendingBytes = 0;
		droppingOversizedLine = false;
	};

	try {
		fd = fs.openSync(record.sessionFile, "r");
		for (;;) {
			const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			let start = 0;
			for (let index = 0; index < bytesRead; index += 1) {
				if (chunk[index] !== 0x0a) continue;
				append(chunk.subarray(start, index));
				finishLine();
				start = index + 1;
			}
			append(chunk.subarray(start, bytesRead));
		}
		if (pendingBytes > 0 || droppingOversizedLine) finishLine();
	} catch (error) {
		issue = `Could not stream child session ${record.sessionFile}: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Recovery file cleanup is best-effort.
			}
		}
	}
	return { output: lastAssistant, issue };
}

function compactLegacyStdout(record: PersistedSubagentRecord): void {
	if (!record.stdoutFile || !hasNonEmptyFile(record.outputFile)) return;
	try {
		const size = fs.statSync(record.stdoutFile).size;
		if (size <= STDOUT_LOG_MAX_BYTES) return;
		fs.writeFileSync(
			record.stdoutFile,
			`[legacy stdout compacted after result recovery; original bytes: ${size}]\n`,
			{ mode: 0o600 },
		);
	} catch {
		// Legacy diagnostic cleanup must not change the recovered result state.
	}
}

function ensureResultFile(
	record: PersistedSubagentRecord,
	stderr: { text: string; issue?: string },
): void {
	if (!record.outputFile || hasNonEmptyFile(record.outputFile)) return;
	try {
		if (record.error) {
			fs.writeFileSync(record.outputFile, "(error)\n", { mode: 0o600 });
			return;
		}
		const recovered = recoverFinalOutput(record);
		if (recovered.output) {
			fs.writeFileSync(record.outputFile, `${recovered.output}\n`, {
				mode: 0o600,
			});
		} else if (stderr.text.trim()) {
			record.error = stderr.text.trim();
			fs.writeFileSync(record.outputFile, "(error)\n", { mode: 0o600 });
		} else if (recovered.issue || stderr.issue) {
			record.error = recovered.issue ?? stderr.issue;
			fs.writeFileSync(record.outputFile, "(error)\n", { mode: 0o600 });
		} else {
			fs.writeFileSync(record.outputFile, "(no output)\n", { mode: 0o600 });
		}
	} catch (error) {
		record.error ??=
			`Could not create subagent result: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function refreshRecord(record: PersistedSubagentRecord): {
	record: PersistedSubagentRecord;
	changed: boolean;
} {
	if (!record.running || isPidRunning(record.pid)) {
		return { record, changed: false };
	}
	const refreshed: PersistedSubagentRecord = { ...record };
	refreshed.running = false;
	refreshed.updatedAt = Date.now();
	refreshed.completedAt ??= Date.now();

	const hadExistingResult = hasNonEmptyFile(refreshed.outputFile);
	const stderr = readDiagnosticFile(refreshed.stderrFile, "child stderr");
	ensureResultFile(refreshed, stderr);
	if (hadExistingResult || refreshed.sessionFile) compactLegacyStdout(refreshed);
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

function resultPathForRecord(record: PersistedSubagentRecord): string {
	return (
		record.outputFile ??
		path.join(record.parentSessionId, "subagents", record.id, "result.log")
	);
}

function formatStatus(
	record: PersistedSubagentRecord,
): AgentToolResult<ToolDetails> {
	const refreshed = refreshRecordFromDisk(record);
	const details: ToolDetails = {
		id: refreshed.id,
		sessionId: refreshed.id,
		running: refreshed.running,
		resultPath: resultPathForRecord(refreshed),
		...(refreshed.error ? { error: refreshed.error } : {}),
	};
	return {
		content: [
			{ type: "text", text: JSON.stringify(details, null, 2) },
			...(refreshed.running
				? [{
						type: "text" as const,
						text: "This is a snapshot. Do not poll or sleep for the result; you will be notified when the subagent completes.",
					}]
				: []),
		],
		details,
	};
}

const TAIL_SUBAGENT_DEFAULT_LINES = 20;
const TAIL_SUBAGENT_MAX_READ_BYTES = 1024 * 1024;

function readRecentCompleteLines(filePath: string, lines: number): string[] {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const snapshotSize = fs.fstatSync(fd).size;
		if (snapshotSize === 0) return [];

		const windowStart = Math.max(0, snapshotSize - TAIL_SUBAGENT_MAX_READ_BYTES);
		const readStart = windowStart > 0 ? windowStart - 1 : 0;
		const buffer = Buffer.allocUnsafe(snapshotSize - readStart);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = fs.readSync(
				fd,
				buffer,
				bytesRead,
				buffer.length - bytesRead,
				readStart + bytesRead,
			);
			if (count === 0) break;
			bytesRead += count;
		}
		const snapshot = buffer.subarray(0, bytesRead);
		const completeEnd = snapshot.lastIndexOf(0x0a);
		if (completeEnd < 0) return [];

		let completeStart = 0;
		if (readStart > 0) {
			if (snapshot[0] === 0x0a) completeStart = 1;
			else {
				const firstNewline = snapshot.indexOf(0x0a);
				if (firstNewline < 0) return [];
				completeStart = firstNewline + 1;
			}
		}
		if (completeEnd < completeStart) return [];
		return snapshot
			.subarray(completeStart, completeEnd)
			.toString("utf-8")
			.split("\n")
			.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
			.filter((line) => line.length > 0)
			.slice(-lines);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
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
	set(
		"cohortFinalNotified",
		latest.cohortFinalNotified || refreshed.cohortFinalNotified,
	);
	set("notifiedAt", refreshed.notifiedAt ?? latest.notifiedAt);
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
	set("notifyError", refreshed.notifyError || latest.notifyError);
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
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

type SubagentDisplayStatus = "running" | "completed" | "error" | "timed-out";

function displayStatus(record: PersistedSubagentRecord): SubagentDisplayStatus {
	if (record.running) return "running";
	if (record.error && /\b(?:timed?\s*out|timeout)\b/i.test(record.error))
		return "timed-out";
	if (record.error) return "error";
	return "completed";
}

function elapsedMs(record: PersistedSubagentRecord): number {
	const end = record.running
		? Date.now()
		: (record.completedAt ?? record.updatedAt);
	return Math.max(0, end - record.createdAt);
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function subagentSelectItems(records: PersistedSubagentRecord[]): SelectItem[] {
	return records.map((record) => ({
		value: record.id,
		label: `${displayStatus(record)}  ${formatElapsed(elapsedMs(record))}  ${record.id.slice(0, 8)}`,
		description: sanitizePreview(record.taskPreview),
	}));
}

async function showSubagentDetails(
	ctx: ExtensionContext,
	record: PersistedSubagentRecord,
): Promise<void> {
	const status = displayStatus(record);
	const lines = [
		"Subagent details",
		"",
		`ID: ${record.id}`,
		`Status: ${status}`,
		`Elapsed: ${formatElapsed(elapsedMs(record))}`,
		`Task: ${sanitizePreview(record.taskPreview) || "(empty)"}`,
		`Working directory: ${record.cwd}`,
		`Model: ${record.model ?? "(inherited)"}`,
		`Started: ${new Date(record.createdAt).toISOString()}`,
		...(record.completedAt
			? [`Completed: ${new Date(record.completedAt).toISOString()}`]
			: []),
		`Result: ${record.outputFile ?? "(unavailable)"}`,
		`Stderr: ${record.stderrFile}`,
		...(record.error ? [`Error: ${sanitizePreview(record.error)}`] : []),
		"",
		"enter/esc close",
	];

	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const text = new Text(
			lines
				.map((line, index) =>
					index === 0 ? theme.fg("accent", theme.bold(line)) : line,
				)
				.join("\n"),
			1,
			0,
		);
		return {
			render: (width: number) => text.render(width),
			invalidate: () => text.invalidate(),
			handleInput(data: string) {
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape))
					done(undefined);
			},
		};
	});
}

async function showSubagents(ctx: ExtensionContext): Promise<void> {
	const mode = (ctx as ExtensionContext & { mode?: string }).mode;
	if (mode ? mode !== "tui" : !ctx.hasUI) {
		ctx.ui.notify("/subagents requires TUI mode", "error");
		return;
	}

	const records = reconcileStore(parentSessionId(ctx)).records;
	if (records.length === 0) {
		ctx.ui.notify("No subagents for this session", "info");
		return;
	}

	const selectedId = await ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0),
			);
			const selectList = new SelectList(
				subagentSelectItems(records),
				Math.min(records.length, 10),
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			);
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(
				new Text(
					theme.fg("dim", "↑↓ navigate • enter details • esc cancel"),
					1,
					0,
				),
			);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);

	if (!selectedId) return;
	const selected = records.find((record) => record.id === selectedId);
	if (selected) await showSubagentDetails(ctx, selected);
}

function formatRunningLine(record: PersistedSubagentRecord): string {
	const elapsed = Math.floor((Date.now() - record.createdAt) / 1000);
	const statusText = record.running
		? `running ${elapsed}s`
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
	let stdoutStream: CappedLogWriter | undefined;
	let stderrStream: CappedLogWriter | undefined;
	const built = buildArgsForRecord(ctx, record, task);

	try {
		upsertRecord(record);
		const spawnSpec = getPiSpawnCommand(built.args);
		stdoutStream = new CappedLogWriter(
			record.stdoutFile,
			STDOUT_LOG_MAX_BYTES,
		);
		stderrStream = new CappedLogWriter(
			record.stderrFile,
			STDERR_LOG_MAX_BYTES,
		);
		// Log failures are collected during finalization instead of becoming
		// uncaught stream errors that bypass terminal record persistence.
		stdoutStream.on("error", () => {});
		stderrStream.on("error", () => {});
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
		stdoutStream?.destroy();
		stderrStream?.destroy();
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

	if (!stdoutStream || !stderrStream) {
		throw new Error("Subagent log streams were not created.");
	}
	const stdoutLog = stdoutStream;
	const stderrLog = stderrStream;

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

	stdoutLog.on("error", () => child.stdout?.resume());
	stderrLog.on("error", () => child.stderr?.resume());
	child.stdout.pipe(stdoutLog);
	child.stderr.pipe(stderrLog);

	const done = new Promise<PersistedSubagentRecord>((resolve) => {
		let finalized = false;

		async function finalizeChild(
			code: number | null,
			signal: NodeJS.Signals | null,
		) {
			if (finalized) return;
			finalized = true;

			if (!stdoutLog.writableEnded) stdoutLog.end();
			if (!stderrLog.writableEnded) stderrLog.end();
			const logIssues = await Promise.all(
				([
					[stdoutLog, "stdout"],
					[stderrLog, "stderr"],
				] as const).map(async ([stream, label]) => {
					try {
						await finished(stream);
						return undefined;
					} catch (error) {
						return `Could not persist child ${label} log: ${error instanceof Error ? error.message : String(error)}`;
					}
				}),
			);

			runningChildren.delete(record.id);
			// Release the lifeline on normal child completion.
			closeLifeline(record.id);
			cleanupTempDir(built.tempDir);

			record.running = false;
			record.completedAt = Date.now();
			record.updatedAt = Date.now();
			record.error ??= logIssues.find((issue) => issue !== undefined);

			const stderr = readDiagnosticFile(record.stderrFile, "child stderr");
			if (code !== null && code !== 0 && !record.error) {
				record.error =
					stderr.text.trim() ||
					stderr.issue ||
					`Subagent exited with code ${code}${signal ? ` (${signal})` : ""}`;
			}

			ensureResultFile(record, stderr);
			record.result = record.outputFile;
			try {
				recordDiscoveredSessionFile(record);
			} catch {
				// Session-file discovery is best-effort after terminal persistence.
			}

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
			"Spawn a child Pi subagent for one task. model is an explicit override; omitting it inherits the active parent provider/model. This returns immediately, allowing the parent to spawn multiple concurrent subagents by calling spawn_subagent multiple times.",
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
			retryPendingCompletionNotices(pi, parentId);
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
				.catch(() => {});
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

	const listTool: ToolDefinition<typeof ListSubagentsParams, ToolDetails> = {
		name: "list_subagents",
		label: "List subagents",
		description:
			"List persisted subagents for the current parent session and their latest status.",
		parameters: ListSubagentsParams,
		async execute(
			_toolCallId,
			_params: Record<string, never>,
			_signal,
			_onUpdate,
			ctx,
		) {
			const { records } = reconcileStore(parentSessionId(ctx));
			const subagents = records.map((record) => ({
				id: record.id,
				running: record.running,
			}));
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

	const statusTool: ToolDefinition<
		typeof GetSubagentStatusParams,
		ToolDetails
	> = {
		name: "get_subagent_status",
		label: "Get subagent status",
		description:
			"Get one snapshot of a subagent's status and result path. Running subagents still notify you on completion; do not poll this tool.",
		parameters: GetSubagentStatusParams,
		async execute(
			_toolCallId,
			params: GetSubagentStatusParamsLike,
			_signal,
			_onUpdate,
			ctx,
		) {
			const record = findRecord(parentSessionId(ctx), params.id);
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

	const tailTool: ToolDefinition<typeof TailSubagentParams, ToolDetails> = {
		name: "tail_subagent",
		label: "Tail subagent",
		description:
			"Read one snapshot of recent complete NDJSON lines from a subagent's stdout log. A trailing line still being written is omitted.",
		parameters: TailSubagentParams,
		async execute(
			_toolCallId,
			params: TailSubagentParamsLike,
			_signal,
			_onUpdate,
			ctx,
		) {
			const record = findRecord(parentSessionId(ctx), params.id);
			if (!record) throw new Error(`Unknown subagent id: ${params.id}`);
			const refreshed = refreshRecordFromDisk(record);
			const lines = readRecentCompleteLines(
				refreshed.stdoutFile,
				params.lines ?? TAIL_SUBAGENT_DEFAULT_LINES,
			);
			return {
				content: [{
					type: "text",
					text: lines.join("\n") || "No complete stdout lines.",
				}],
				details: { id: refreshed.id, running: refreshed.running, lines },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("tail_subagent "))}${theme.fg("accent", args.id)}`,
				0,
				0,
			);
		},
	};

	pi.registerTool(spawnTool);
	pi.registerTool(listTool);
	pi.registerTool(statusTool);
	pi.registerTool(tailTool);

	if (typeof pi.registerCommand === "function") {
		pi.registerCommand("subagents", {
			description: "List subagents",
			handler: async (_args, ctx) => showSubagents(ctx),
		});
	}
	if (typeof pi.registerShortcut === "function") {
		pi.registerShortcut(Key.ctrlShift("s"), {
			description: "List subagents",
			handler: showSubagents,
		});
	}

	if (typeof pi.on === "function") {
		pi.on("session_start", (_event, ctx) => {
			rememberUiContext(ctx);
			const parentId = parentSessionId(ctx);
			reconcileStore(parentId);
			if (hasUiWidget(ctx)) {
				renderRunningWidget(ctx, parentId);
				scheduleWidgetRefresh(parentId);
			}
			retryPendingCompletionNotices(pi, parentId);
		});

		pi.on("agent_end", (_event, ctx) => {
			rememberUiContext(ctx);
			const parentId = parentSessionId(ctx);
			closeActiveCohort(parentId);
			if (hasUiWidget(ctx)) {
				renderRunningWidget(ctx, parentId);
				scheduleWidgetRefresh(parentId);
			}
			// Headless/print mode: parent process stays alive naturally because
			// child stdout/stderr pipes to capped log writers keep Node's event loop alive.
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
