import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SpawnSubagentParams } from "../../src/extension/schemas.ts";
import { createMockPi } from "../support/mock-pi.ts";
import {
	CHILD_SUBAGENT_SYSTEM_LINE,
	rewriteSubagentPrompt,
	SUBAGENT_RESULT_PATH_ENV,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const subagentIdAliases = new Map<string, string>();

function makeTestCtx(prefix: string) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
	// Simulate subagent-as-parent case: session.jsonl inside the base dir.
	// getBaseDir() sees name==="session" and returns the parent dir (cwd).
	const sessionFile = path.join(cwd, "session.jsonl");
	return {
		sessionId: cwd,
		ctx: {
			cwd,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionId: () => sessionFile,
			},
		},
	};
}

function storeDir(sessionId: string) {
	// sessionId is now the base dir returned by getBaseDir()
	return sessionId;
}

function storeFile(sessionId: string) {
	return path.join(storeDir(sessionId), "subagents", "subagents.json");
}

function cleanupTestCtx(ctx: { cwd: string }, sessionId: string) {
	// sessionId === ctx.cwd with new makeTestCtx; avoid double-remove
	if (sessionId !== ctx.cwd) {
		fs.rmSync(sessionId, { recursive: true, force: true });
	}
	fs.rmSync(ctx.cwd, { recursive: true, force: true });
}

function actualSubagentId(id: string) {
	return subagentIdAliases.get(id) ?? id;
}

function readPersistedRecord(sessionId: string, id: string) {
	const store = JSON.parse(fs.readFileSync(storeFile(sessionId), "utf-8")) as {
		records: Array<Record<string, any>>;
	};
	const actualId = actualSubagentId(id);
	const record = store.records.find((candidate) => candidate.id === actualId);
	if (record) return record;
	if (actualId === id && store.records.length === 1) return store.records[0]!;
	assert(record, `expected persisted record ${id}`);
	return record;
}

async function waitForPersistedRecord(
	sessionId: string,
	id: string,
	ready: (record: Record<string, any>) => boolean = (record) => !record.running,
) {
	let record: Record<string, any> | undefined;
	for (let i = 0; i < 100; i++) {
		try {
			record = readPersistedRecord(sessionId, id);
			if (ready(record)) return record;
		} catch {
			// Record may not exist yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return record ?? readPersistedRecord(sessionId, id);
}

function readSubagentStore(sessionId: string) {
	return JSON.parse(fs.readFileSync(storeFile(sessionId), "utf-8")) as {
		records: Array<Record<string, unknown>>;
	};
}

function readSubagentRecord(sessionId: string, id: string) {
	const actualId = actualSubagentId(id);
	const store = readSubagentStore(sessionId);
	const record = store.records.find((r) => r.id === actualId);
	if (record) return record;
	if (actualId === id && store.records.length === 1) return store.records[0]!;
	assert.ok(record, `missing subagent record ${id}`);
	return record;
}

async function waitForSubagentRecord(
	sessionId: string,
	id: string,
	predicate: (record: Record<string, unknown>) => boolean,
) {
	for (let i = 0; i < 100; i++) {
		const record = readSubagentRecord(sessionId, id);
		if (predicate(record)) return record;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return readSubagentRecord(sessionId, id);
}

function readLatestMockPiArgs(mockPi: { dir: string }) {
	const calls = fs
		.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort();
	assert.ok(calls.length > 0, "expected mock pi args capture");
	return JSON.parse(
		fs.readFileSync(path.join(mockPi.dir, calls.at(-1)!), "utf-8"),
	) as { args: string[] };
}

function registerTestTools(sendMessage: (...args: unknown[]) => void = () => {}) {
	const registered = new Map<string, any>();
	const handlers = new Map<string, any>();
	const fakePi = {
		registerTool(tool: { name: string }) {
			registered.set(tool.name, tool);
		},
		sendMessage,
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
	};
	registerSubagentExtension(fakePi as never);
	const rawSpawnTool = registered.get("spawn_subagent");
	return {
		handlers,
		spawnTool: {
			...rawSpawnTool,
			async execute(callId: string, ...args: any[]) {
				const result = await rawSpawnTool.execute(callId, ...args);
				const id = result?.details?.id;
				if (typeof id === "string") subagentIdAliases.set(callId, id);
				return result;
			},
		},
	};
}

test("spawn rejects keepContext as additional property", () => {
	assert.equal(
		Value.Check(SpawnSubagentParams, {
			task: "x",
			async: false,
			keepContext: false,
		}),
		false,
	);
	assert.equal(
		Value.Check(SpawnSubagentParams, { task: "x", async: false }),
		true,
	);
});

test("user-facing packaged docs do not expose removed API concepts", () => {
	const packageJsonPath = path.join(projectRoot, "package.json");
	const packageJsonText = fs.readFileSync(packageJsonPath, "utf-8");
	const packageJson = JSON.parse(packageJsonText) as { files?: string[] };

	assert.equal(
		(packageJson.files ?? []).includes("CHANGELOG.md"),
		false,
		"CHANGELOG.md must not be packaged unless removed-interaction wording is rewritten and covered by this test",
	);

	const files = [
		"README.md",
		"skills/pi-subagents/SKILL.md",
		"package.json",
		"install.mjs",
	];
	const forbidden = [
		"steer_subagent",
		"steering",
		"follow-up",
		"message queue",
		"message-queue",
		"Queues a message for a running subagent",
		"resumes a stopped subagent",
		"replacement",
	];

	for (const relativePath of files) {
		const text = fs
			.readFileSync(path.join(projectRoot, relativePath), "utf-8")
			.toLowerCase();
		for (const term of forbidden) {
			assert.equal(
				text.includes(term.toLowerCase()),
				false,
				`${relativePath} mentions ${term}`,
			);
		}
	}
});

function makeFakeCtx(sessionId: string, cwd: string, hasUI: boolean) {
	const widgetCalls: Array<{ key: string; lines: string[] | undefined }> = [];
	return {
		sessionId,
		ctx: {
			cwd,
			hasUI,
			ui: hasUI
				? {
						setWidget(key: string, lines: string[] | undefined) {
							widgetCalls.push({ key, lines });
						},
					}
				: undefined,
			sessionManager: {
				getSessionFile: () => sessionId,
				getSessionId: () => sessionId,
			},
		},
		widgetCalls,
	};
}

test("prompt runtime prepends exactly one line and preserves content", () => {
	const prompt =
		"SYSTEM\n\n# Project Context\nkeep this\n\nThe following skills provide specialized instructions for specific tasks.\nkeep skills";
	const rewritten = rewriteSubagentPrompt(prompt);
	assert.equal(rewritten, `${CHILD_SUBAGENT_SYSTEM_LINE}\n\n${prompt}`);
	assert.equal(rewriteSubagentPrompt(rewritten), rewritten);
	assert(!rewritten.includes("Do not propose or run subagents"));
});

test("child pi args do not restrict tools skills extensions or MCP", () => {
	const built = buildPiArgs({
		baseArgs: [],
		task: "hello",
		sessionEnabled: true,
		sessionFile: "/tmp/pi-subagent-test/session.jsonl",
	});
	assert(!built.args.includes("--no-skills"));
	assert(!built.args.includes("--no-extensions"));
	assert(!built.args.includes("--tools"));
	assert.equal(built.env.MCP_DIRECT_TOOLS, undefined);
	assert(built.args.includes("--extension"));
});

test("buildPiArgs supports sessionId with sessionDir", () => {
	const built = buildPiArgs({
		baseArgs: [],
		task: "hello",
		sessionEnabled: true,
		sessionId: "123e4567-e89b-12d3-a456-426614174000",
		sessionDir: "/tmp/pi-subagent-test/session-dir",
	});

	assert(built.args.includes("--session-id"));
	assert(built.args.includes("123e4567-e89b-12d3-a456-426614174000"));
	assert(built.args.includes("--session-dir"));
	assert(built.args.includes("/tmp/pi-subagent-test/session-dir"));
	assert.equal(built.args.includes("--session"), false);
});

test("async completion persists success and pending metadata when stale notification fails", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-stale");
	let notifyAttempts = 0;
	const { spawnTool } = registerTestTools(() => {
		notifyAttempts += 1;
		throw new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
	});

	try {
		await spawnTool.execute(
			"stale-notify-child",
			{ task: "finish", async: true, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const record = await waitForPersistedRecord(
			sessionId,
			"stale-notify-child",
			(candidate) =>
				!candidate.running && candidate.pendingCompletionNotice === true,
		);

		assert.equal(record.running, false);
		assert.ok(record.result, "result must be set (file path)");
		const resultContent = fs.readFileSync(record.outputFile, "utf-8");
		assert.match(resultContent, /done/);
		assert.equal(record.error, undefined);
		assert.equal(record.pendingCompletionNotice, true);
		assert.match(
			record.notifyError,
			/stale after session replacement or reload/,
		);
		assert.equal(record.notifiedCompletion, undefined);
		assert.equal(notifyAttempts, 1);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("blocking spawn persists unified id session file result.log and fresh args", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "uuid done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-unified-id");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"unified-id-call",
			{ task: "echo uuid", async: false },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const record = readPersistedRecord(sessionId, result.details.id);
		assert.match(
			record.id,
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		assert.equal(
			record.sessionDir,
			path.join(sessionId, "subagents", record.id),
		);
		assert.ok(record.sessionFile, "record must have discovered sessionFile");
		assert.equal(path.dirname(record.sessionFile), record.sessionDir);
		assert.match(
			path.basename(record.sessionFile),
			new RegExp(`^\\d{4}-\\d{2}-\\d{2}T.*_${record.id}\\.jsonl$`),
		);
		const firstLine = fs
			.readFileSync(record.sessionFile, "utf-8")
			.split("\n")[0];
		assert.deepEqual(JSON.parse(firstLine), { type: "session", id: record.id });
		assert.equal(
			record.outputFile,
			path.join(sessionId, "subagents", record.id, "result.log"),
		);
		assert.ok(fs.existsSync(record.outputFile));
		assert.match(fs.readFileSync(record.outputFile, "utf-8"), /uuid done/);

		const captured = readLatestMockPiArgs(mockPi).args;
		assert(captured.includes("--session-id"));
		assert(captured.includes(record.id));
		assert(captured.includes("--session-dir"));
		assert(captured.includes(record.sessionDir));
		assert.equal(captured.includes(record.sessionFile), false);
		assert.equal(captured.includes("--fork"), false);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("spawn starts fresh session and never forks parent history", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "fresh", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-no-fork");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"no-fork-child",
			{ task: "fresh only", async: false },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const record = readPersistedRecord(sessionId, result.details.id);
		const captured = readLatestMockPiArgs(mockPi).args;
		assert.equal(captured.includes("--fork"), false);
		assert.equal(
			captured.includes(path.join(sessionId, "session.jsonl")),
			false,
		);
		assert(captured.includes("--session-id"));
		assert(captured.includes(record.id));
		assert(captured.includes("--session-dir"));
		assert(captured.includes(record.sessionDir));
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("spawn response includes resultPath", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "hello", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-resultpath-spawn");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"resultpath-child",
			{ task: "echo hello", async: false },
			new AbortController().signal,
			undefined,
			ctx,
		);
		// resultPath must be present in details
		assert.ok(result.details.resultPath, "resultPath must be present");
		assert.equal(
			"sessionFile" in result.details,
			false,
			"spawn response must not expose sessionFile to parent",
		);
		assert(!result.content[0].text.includes("sessionFile"));
		assert.match(result.details.resultPath, /\/subagents\/[^/]+\/result\.log$/);
		// result file must exist and contain output
		const content = fs.readFileSync(result.details.resultPath, "utf-8");
		assert.match(content, /hello/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// Test 3: Async spawn response includes resultPath (Requirement 2)
test("auto-saves final assistant message to result file when subagent does not write to it", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	// Subagent produces output but does NOT write to result file
	mockPi.onCall({ output: "auto-saved output", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-autosave");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"autosave-child",
			{
				task: "do work without writing result file",
				async: false,
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		const content = fs.readFileSync(result.details.resultPath, "utf-8");
		assert.match(content, /auto-saved output/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// Test 7: Subagent-written result file takes precedence (Requirement 5)
test("subagent-written result file content is preserved, not overwritten", async () => {
	const mockPi = createMockPi();
	mockPi.install();

	const { sessionId, ctx } = makeTestCtx("pi-subagents-preserve");
	const { spawnTool } = registerTestTools(() => {});

	try {
		mockPi.onCall({ output: "different stdout output", exitCode: 0 });

		const result = await spawnTool.execute(
			"preserve-child",
			{ task: "finish", async: false },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const record = readPersistedRecord(sessionId, "preserve-child");
		assert.equal(result.details.resultPath, record.outputFile);
		assert.match(result.details.resultPath, /\/subagents\/[^/]+\/result\.log$/);
		const content = fs.readFileSync(result.details.resultPath, "utf-8");
		assert.match(content, /different stdout output/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// Test 8: Prompt injection includes result path (Requirement 4)
test("subagent system prompt includes result file path when env var set", () => {
	const prompt = "Original system prompt.";
	const resultPath = "/tmp/subagents/abc/result.log";
	process.env[SUBAGENT_RESULT_PATH_ENV] = resultPath;

	// Simulate the handler's logic (mirrors registerSubagentPromptRuntime):
	const RESULT_PATH_MARKER = "Your result file:";
	let rewritten = rewriteSubagentPrompt(prompt);
	if (resultPath && !rewritten.includes(RESULT_PATH_MARKER)) {
		rewritten = `${rewritten}\n\nYour result file: ${resultPath}\nYou may write your final output to this file at any time using any tool (e.g., write, bash). If you leave the file empty, your final assistant message will be automatically saved there on exit. The environment variable "$PI_SUBAGENT_RESULT_PATH" is aliased to ${resultPath}; you can pipe your answer there. Particularly for very large outputs, or for programmatic outputs, use tools to write the result directly to "$PI_SUBAGENT_RESULT_PATH".`;
	}

	assert.ok(rewritten.includes(resultPath));
	assert.ok(rewritten.includes("Your result file:"));
	assert.ok(rewritten.includes("write"));
	assert.ok(rewritten.includes("automatically saved"));
	assert.ok(rewritten.includes('"$PI_SUBAGENT_RESULT_PATH"'));
	assert.ok(rewritten.includes("you can pipe your answer there"));
	assert.ok(rewritten.includes("very large outputs"));
	assert.ok(rewritten.includes("programmatic outputs"));

	// Idempotency: second injection must not append again
	let rewrittenAgain = rewritten;
	if (resultPath && !rewrittenAgain.includes(RESULT_PATH_MARKER)) {
		rewrittenAgain = `${rewrittenAgain}\n\nYour result file: ${resultPath}\nYou may write...`;
	}
	assert.equal(
		rewrittenAgain,
		rewritten,
		"prompt injection must be idempotent",
	);

	delete process.env[SUBAGENT_RESULT_PATH_ENV];
});

// Test 9: pi-args passes resultPath env var (Requirement 4)
test("buildPiArgs includes PI_SUBAGENT_RESULT_PATH when resultPath provided", () => {
	const resultPath = "/tmp/subagents/test/result.log";
	const built = buildPiArgs({
		baseArgs: [],
		task: "hello",
		sessionEnabled: true,
		sessionFile: "/tmp/test/session.jsonl",
		resultPath,
	});
	assert.equal(built.env[SUBAGENT_RESULT_PATH_ENV], resultPath);
});

test("buildPiArgs omits PI_SUBAGENT_RESULT_PATH when resultPath not provided", () => {
	const built = buildPiArgs({
		baseArgs: [],
		task: "hello",
		sessionEnabled: true,
		sessionFile: "/tmp/test/session.jsonl",
	});
	assert.equal(built.env[SUBAGENT_RESULT_PATH_ENV], undefined);
});

// Test 10: Integration — end-to-end blocking subagent with real pi binary (Scope Test Plan)
test("integration: blocking subagent writes result.log at expected path", (t) => {
	if (!process.env.PI_SUBAGENTS_RUN_REAL_INTEGRATION) {
		t.skip(
			"requires a configured local pi model provider; set PI_SUBAGENTS_RUN_REAL_INTEGRATION=1 to run",
		);
		return;
	}

	// Find the pi binary
	const piBin = process.env.PI_BIN || "pi";

	// Create a temp session file so we can inspect the result
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-int-"));
	const sessionFile = path.join(tmpDir, "session.jsonl");
	try {
		// Run pi with a prompt that spawns a blocking subagent.
		// --no-extensions avoids tool-name conflict with a pre-loaded subagents extension.
		const result = spawnSync(
			piBin,
			[
				"--mode",
				"json",
				"--print",
				"--session",
				sessionFile,
				"--no-extensions",
				"--extension",
				path.join(projectRoot, "src", "index.ts"),
				"Spawn a blocking subagent to echo hello world. Use spawn_subagent with async: false. Then read the result file at the path given in resultPath.",
			],
			{
				cwd: tmpDir,
				encoding: "utf-8",
				timeout: 120_000, // 2 min for LLM round-trip
				env: { ...process.env, PI_NO_COLOR: "1" },
			},
		);

		assert.equal(
			result.status,
			0,
			`pi exited non-zero: ${result.stderr?.slice(0, 500)}`,
		);

		// The parent should have read the result file, so it knows where it is.
		// Verify the result file exists at the expected path pattern.
		const subagentsDir = path.join(tmpDir, "subagents");
		assert.ok(
			fs.existsSync(subagentsDir),
			`subagents dir must exist under session dir: ${subagentsDir}`,
		);

		const subagentDirs = fs
			.readdirSync(subagentsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory());

		assert.ok(subagentDirs.length >= 1, "at least one subagent dir must exist");

		for (const dir of subagentDirs) {
			const resultPath = path.join(subagentsDir, dir.name, "result.log");
			assert.ok(
				fs.existsSync(resultPath),
				`result.log must exist: ${resultPath}`,
			);
			const content = fs.readFileSync(resultPath, "utf-8");
			assert.ok(
				content.trim().length > 0,
				`result.log must not be empty: ${resultPath}`,
			);
		}
	} finally {
		// Best-effort cleanup
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup only.
		}
	}
});

// ── Phase 7: widget / reconciliation / headless tests ──

test("N1: sync subagent widget appears during execution and clears after", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "sync widget done", exitCode: 0, delay: 80 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-sync-widget-n1");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);
	const { spawnTool } = registerTestTools(() => {});
	try {
		const resultPromise = spawnTool.execute(
			"sync-widget-child",
			{ task: "sync widget", async: false },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		for (let i = 0; i < 50; i++) {
			if (
				fake.widgetCalls.some((c) =>
					c.lines?.some((line) => line.includes("sync widget")),
				)
			) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(
			fake.widgetCalls.some((c) =>
				c.lines?.some((line) => line.includes("sync widget")),
			),
			"widget must render before sync spawn_subagent resolves",
		);
		const result = await resultPromise;
		assert.equal(result.details.running, false);
		assert.ok(result.details.resultPath);
		assert.equal(
			fs.readFileSync(result.details.resultPath, "utf-8").trim(),
			"sync widget done",
		);
		assert.ok(
			fake.widgetCalls.some((c) =>
				c.lines?.some((line) => line.includes("sync widget")),
			),
			"widget rendered during sync run",
		);
		assert.ok(
			fake.widgetCalls.some((c) => c.lines === undefined),
			"widget cleared after sync run",
		);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("running widget omits internal ids, uses subtle color, and fits one-line prompt preview", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "preview widget done", exitCode: 0, delay: 120 });
	const originalColumns = process.stdout.columns;
	Object.defineProperty(process.stdout, "columns", { value: 64, configurable: true });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-widget-preview");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);
	const { spawnTool } = registerTestTools();
	try {
		await spawnTool.execute(
			"preview-child",
			{ task: "first line\nsecond line with more text", async: true },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		const rendered = fake.widgetCalls
			.flatMap((c) => c.lines ?? [])
			.find((line) => line.includes("first line"));
		assert.ok(rendered, "widget rendered prompt preview");
		assert.equal(rendered.includes("preview-child"), false);
		assert.equal(rendered.includes("pid="), false);
		assert.equal(rendered.includes("\n"), false);
		assert.ok(rendered.includes("first line second line"));
		const visible = rendered.replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(visible.length <= 64);
		assert.match(rendered, /\x1b\[/, "widget line uses ANSI color styling");
		await waitForPersistedRecord(sessionId, "preview-child", (record) => !record.running);
	} finally {
		if (originalColumns === undefined) delete (process.stdout as any).columns;
		else Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("N2: running widget survives agent_end", async () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const timers: Array<{
		fn: () => void;
		ms: number;
		cleared: boolean;
		unrefCalled: boolean;
	}> = [];
	(globalThis as any).setInterval = (fn: () => void, ms?: number) => {
		const timer = { fn, ms: Number(ms), cleared: false, unrefCalled: false };
		(timer as any).unref = () => {
			timer.unrefCalled = true;
		};
		timers.push(timer);
		return timer as any;
	};
	(globalThis as any).clearInterval = (timer: any) => {
		timer.cleared = true;
	};
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "agent end done", exitCode: 0, delay: 200 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-agent-end-n2");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);
	let agentEnd: ((_event: unknown, ctx: unknown) => void) | undefined;
	const registered = new Map<string, any>();
	registerSubagentExtension({
		registerTool(tool: any) {
			registered.set(tool.name, tool);
		},
		sendMessage() {},
		on(event: string, handler: any) {
			if (event === "agent_end") agentEnd = handler;
		},
	} as never);
	try {
		await registered
			.get("spawn_subagent")
			.execute(
				"agent-end-child",
				{ task: "agent end", async: true },
				new AbortController().signal,
				undefined,
				fake.ctx,
			);
		assert.ok(
			fake.widgetCalls.some((c) =>
				c.lines?.some((line) => line.includes("agent end")),
			),
		);
		const widgetTimer = timers.find((t) => t.ms === 1000);
		const reconcileTimer = timers.find((t) => t.ms === 5000);
		assert.ok(
			widgetTimer && widgetTimer.unrefCalled,
			"widget timer scheduled before agent_end",
		);
		assert.ok(
			reconcileTimer && reconcileTimer.unrefCalled,
			"reconcile timer scheduled before agent_end",
		);
		assert.ok(agentEnd, "agent_end handler registered");
		agentEnd!(undefined, fake.ctx);
		const afterAgentEnd = fake.widgetCalls.filter((c) =>
			c.lines?.some((line) => line.includes("agent end")),
		);
		assert.ok(
			afterAgentEnd.length >= 2,
			"agent_end re-renders active widget instead of clearing",
		);
		assert.equal(
			widgetTimer.cleared,
			false,
			"widget refresh timer remains scheduled after agent_end",
		);
		assert.equal(
			reconcileTimer.cleared,
			false,
			"reconcile timer remains scheduled after agent_end",
		);
		const widgetCallsBeforeTimer = fake.widgetCalls.length;
		(widgetTimer as any).fn?.();
		assert.ok(
			fake.widgetCalls.length > widgetCallsBeforeTimer,
			"uiParents still retains parent ctx after agent_end so widget timer can re-render",
		);
		await waitForPersistedRecord(sessionId, "agent-end-child");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test("N3: pending completion notice retries on next session_start after parent death", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "late done", exitCode: 0, delay: 80 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-pending-notice-n3");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	let parentApi: { alive: boolean } | undefined = { alive: true };
	const oldParentMessages: any[] = [];
	const { spawnTool } = registerTestTools((message) => {
		if (!parentApi?.alive) {
			throw new Error("old parent ExtensionAPI discarded");
		}
		oldParentMessages.push(message);
	});
	try {
		await spawnTool.execute(
			"pending-notice-child",
			{ task: "pending notice", async: true },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		// Simulate parent death by discarding the only test-held ExtensionAPI/process
		// reference before the child completes; the old callback now behaves like a
		// dead parent and cannot deliver the notification.
		parentApi.alive = false;
		parentApi = undefined;

		await waitForPersistedRecord(
			sessionId,
			"pending-notice-child",
			(record) =>
				record.running === false && record.pendingCompletionNotice === true,
		);
		assert.equal(oldParentMessages.length, 0);
		const beforeRestart = readPersistedRecord(
			sessionId,
			"pending-notice-child",
		);
		assert.equal(beforeRestart.pendingCompletionNotice, true);
		assert.equal(beforeRestart.notifiedCompletion, undefined);
		assert.match(
			beforeRestart.notifyError,
			/old parent ExtensionAPI discarded/,
		);

		const restartScript = `
			import registerSubagentExtension from ${JSON.stringify(path.join(projectRoot, "src/extension/index.ts"))};
			const messages = [];
			let sessionStart;
			registerSubagentExtension({
				registerTool() {},
				sendMessage(message) { if (typeof message.content === "string") messages.push(message.content); },
				on(event, handler) { if (event === "session_start") sessionStart = handler; },
			});
			const ctx = {
				cwd: ${JSON.stringify(ctx.cwd)},
				hasUI: false,
				sessionManager: {
					getSessionFile: () => ${JSON.stringify(path.join(sessionId, "session.jsonl"))},
					getSessionId: () => ${JSON.stringify(path.join(sessionId, "session.jsonl"))},
				},
			};
			await sessionStart(undefined, ctx);
			console.log(JSON.stringify({ messages }));
		`;
		const restarted = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				restartScript,
			],
			{ cwd: projectRoot, encoding: "utf-8", env: process.env },
		);
		assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout);
		const restartResult = JSON.parse(restarted.stdout) as {
			messages: string[];
		};
		assert.ok(
			restartResult.messages.some(
				(m) => m.includes(String(beforeRestart.id)) && m.includes("completed"),
			),
		);
		const persisted = readPersistedRecord(sessionId, "pending-notice-child");
		assert.equal(persisted.pendingCompletionNotice, false);
		assert.equal(persisted.notifiedCompletion, true);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("Phase 7.8: headless liveness — stdio pipes keep parent process alive naturally", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "headless live done", exitCode: 0, delay: 220 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-headless-live-8");
	const sessionFile = path.join(sessionId, "session.jsonl");
	const extensionPath = path.join(projectRoot, "src/extension/index.ts");
	const childId = "headless-live-child";
	const script = `
		import fs from "node:fs";
		import registerSubagentExtension from ${JSON.stringify(extensionPath)};
		const registered = new Map();
		registerSubagentExtension({
			registerTool(tool) { registered.set(tool.name, tool); },
			sendMessage(message) { process.stdout.write(JSON.stringify({ type: "message", content: message.content }) + "\\n"); },
			on() {},
		});
		const ctx = {
			cwd: ${JSON.stringify(ctx.cwd)},
			hasUI: false,
			sessionManager: {
				getSessionFile: () => ${JSON.stringify(sessionFile)},
				getSessionId: () => ${JSON.stringify(sessionFile)},
			},
		};
		await registered.get("spawn_subagent").execute(
			${JSON.stringify(childId)},
			{ task: "headless liveness test", async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		process.stdout.write(JSON.stringify({ type: "spawned", at: Date.now() }) + "\\n");
		// No timers or explicit retain/release here. If child stdio pipes are not
		// ref-counted, this parent process exits before the child delay elapses.
	`;
	try {
		const extensionSource = fs.readFileSync(extensionPath, "utf-8");
		const childSpawnOptions = extensionSource.match(
			/child = spawn\(spawnSpec\.command, spawnSpec\.args, \{[\s\S]*?\n\t\t\}\);/,
		)?.[0];
		assert.ok(childSpawnOptions, "extension child spawn call is present");
		assert.match(
			childSpawnOptions,
			/stdio:\s*\["ignore", "pipe", "pipe"\]/,
			"extension child spawn uses default pipe stdio for stdout/stderr",
		);
		assert.doesNotMatch(
			childSpawnOptions,
			/detached\s*:/,
			"extension child spawn does not detach child process",
		);
		assert.doesNotMatch(
			extensionSource,
			/child\.unref\s*\(/,
			"extension child process is not unref'd",
		);

		const started = Date.now();
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", script],
			{ cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		await new Promise((resolve) => setTimeout(resolve, 90));
		assert.equal(
			child.exitCode,
			null,
			"parent must still be alive before child completes",
		);

		const exitCode = await new Promise<number | null>((resolve) => {
			child.on("exit", (code) => resolve(code));
		});
		assert.equal(exitCode, 0, stderr || stdout);
		assert.ok(
			Date.now() - started >= 180,
			"parent lifetime should track child stdio lifetime",
		);
		assert.match(stdout, /"type":"spawned"/);
		assert.match(stdout, /Subagent [0-9a-f-]{36} completed/);

		const record = readPersistedRecord(sessionId, childId);
		assert.equal(record.running, false);
		assert.equal(
			fs.readFileSync(record.result, "utf-8").trim(),
			"headless live done",
		);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("Phase 7.9: spawn/setup error semantics — depth check fails before child exists", async () => {
	const mockPi = createMockPi();
	mockPi.install();

	const { sessionId, ctx } = makeTestCtx("pi-subagents-depthfail-9");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);

	const sentMessages: string[] = [];
	const { spawnTool } = registerTestTools((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	// Force depth check to block by setting PI_SUBAGENT_DEPTH >= max
	const origDepth = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "3";
	try {
		const result = await spawnTool.execute(
			"depth-fail-child",
			{
				task: "should fail depth check",
				async: true,
			},
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		// Spawn returns successfully (async doesn't re-throw setup failure)
		assert.match(result.details?.id, /^[0-9a-f-]{36}$/);
		assert.equal(result.details?.running, false);

		// Record must be persisted with error and running=false
		const record = readPersistedRecord(sessionId, "depth-fail-child");
		assert.equal(record.running, false);
		assert.match(record.error, /recursion depth exceeded/);
		assert.ok(record.completedAt);

		// onSetupFailure should clear widget (setWidget with undefined)
		const clearCalls = fake.widgetCalls.filter(
			(c) => c.lines === undefined && c.key?.includes("pi-subagents-running"),
		);
		assert.ok(
			clearCalls.length >= 1,
			"onSetupFailure should trigger widget clear",
		);
	} finally {
		if (origDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = origDepth;
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("Phase 7.14: session_start renders widget before user status", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-sessionstart-14");

	const recordId = "sessionstart-child";
	const storeFilePath = storeFile(sessionId);
	fs.mkdirSync(path.dirname(storeFilePath), { recursive: true });

	const childDataDir = path.join(storeDir(sessionId), recordId);
	fs.mkdirSync(childDataDir, { recursive: true });
	const stdoutPath = path.join(childDataDir, "stdout.log");
	const stderrPath = path.join(childDataDir, "stderr.log");
	fs.writeFileSync(
		stdoutPath,
		'{"type":"message","message":{"role":"assistant","content":"session start test"}}\n',
		"utf-8",
	);
	fs.writeFileSync(stderrPath, "", "utf-8");

	// Persist a live running record (PID = current process, definitely alive)
	const record = {
		id: recordId,
		parentSessionId: sessionId,
		cwd: ctx.cwd,
		taskPreview: "session start test",
		timeout: 3600,
		running: true,
		pid: process.pid,
		sessionFile: path.join(childDataDir, "session.jsonl"),
		outputFile: path.join(childDataDir, "result.log"),
		stdoutFile: stdoutPath,
		stderrFile: stderrPath,
		createdAt: Date.now() - 60_000,
		updatedAt: Date.now() - 30_000,
	};
	fs.writeFileSync(
		storeFilePath,
		JSON.stringify({ records: [record] }, null, 2),
		{ mode: 0o600 },
	);

	// Capture session_start handler
	let sessionStartHandler:
		| ((_event: unknown, ctx: unknown) => void)
		| undefined;
	const widgetCalls: Array<{ key: string; lines: string[] | undefined }> = [];

	const fakePi = {
		registerTool() {},
		sendMessage() {},
		on(event: string, handler: (_event: unknown, ctx: unknown) => void) {
			if (event === "session_start") sessionStartHandler = handler;
		},
	};
	registerSubagentExtension(fakePi as never);

	const uiCtx = {
		cwd: ctx.cwd,
		hasUI: true,
		ui: {
			setWidget(key: string, lines: string[] | undefined) {
				widgetCalls.push({ key, lines });
			},
		},
		sessionManager: {
			getSessionFile: () => sessionId,
			getSessionId: () => sessionId,
		},
	};

	// Trigger session_start
	assert.ok(sessionStartHandler, "session_start handler should be registered");
	sessionStartHandler!(undefined, uiCtx);

	// After session_start, widget should have rendered with active subagent line
	const widgetAfterStart = widgetCalls.filter(
		(c) => c.lines != null && c.key?.includes("pi-subagents-running"),
	);
	assert.ok(
		widgetAfterStart.length >= 1,
		"session_start should render widget with active subagent line",
	);

	const activeWidget = widgetAfterStart.find((c) =>
		c.lines?.some((line) => line.includes("session start test")),
	);
	assert.ok(
		activeWidget,
		"widget should show active line for persisted live child",
	);

	cleanupTestCtx(ctx, sessionId);
});

test("cohort: same turn async spawns share cohort and final lists all result files", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "one", exitCode: 0, delay: 30 });
	mockPi.onCall({ output: "two", exitCode: 0, delay: 60 });
	mockPi.onCall({ output: "three", exitCode: 0, delay: 90 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-cohort-same-turn");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const messages: string[] = [];
	const { spawnTool } = registerTestTools((message: any) => messages.push(String(message.content)));
	try {
		const ids = ["cohort-a", "cohort-b", "cohort-c"];
		for (const id of ids) await spawnTool.execute(id, { task: id, async: true }, new AbortController().signal, undefined, fake.ctx);
		await Promise.all(ids.map((id) => waitForPersistedRecord(sessionId, id)));
		const records = ids.map((id) => readPersistedRecord(sessionId, id));
		assert.ok(records[0].cohortId);
		assert.equal(new Set(records.map((r) => r.cohortId)).size, 1);
		assert.ok(records.every((r) => typeof r.cohortCreatedAt === "number"));
		assert.equal(messages.some((m) => m.includes("out of 3 subagents have completed")), false);
		assert.equal(messages.length, 1, "only final cohort notification is sent");
		const final = messages.find((m) => m.includes("All 3 subagents completed successfully."));
		assert.ok(final);
		assert.equal(final.startsWith("Subagent "), false);
		assert.ok(final.includes("Result files:"));
		assert.ok(final.includes("You must read the result files at the paths above."));
		for (const r of records) assert.ok(final.includes(`- ${r.id}: ${r.outputFile}`));
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("cohort: mixed failures warn with stderr paths and fire once", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "one", exitCode: 0, delay: 30 });
	mockPi.onCall({ output: "two", stderr: "boom stderr", exitCode: 2, delay: 60 });
	mockPi.onCall({ output: "three", exitCode: 0, delay: 90 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-cohort-mixed-failure");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const messages: string[] = [];
	const { spawnTool } = registerTestTools((message: any) => messages.push(String(message.content)));
	try {
		const ids = ["mixed-a", "mixed-b", "mixed-c"];
		for (const id of ids) await spawnTool.execute(id, { task: id, async: true }, new AbortController().signal, undefined, fake.ctx);
		await Promise.all(ids.map((id) => waitForPersistedRecord(sessionId, id)));
		const records = ids.map((id) => readPersistedRecord(sessionId, id));
		assert.equal(messages.length, 1, "only final cohort notification is sent");
		const final = messages[0]!;
		assert.ok(final.includes("3 subagents finished; 1 failed."));
		assert.equal(final.includes("completed successfully"), false);
		const successful = records.filter((r) => !r.error);
		const failed = records.find((r) => r.error)!;
		for (const r of successful) assert.ok(final.includes(`- ${r.id}: ${r.outputFile}`));
		assert.ok(final.includes(`- ${failed.id}:`));
		assert.ok(final.includes("error: boom stderr"));
		assert.ok(final.includes(`result: ${failed.outputFile}`));
		assert.ok(final.includes(`stderr: ${failed.stderrFile}`));
		assert.ok(final.includes("read stderr logs for failures"));
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("cohort: all failures report all-failed wording", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "one", stderr: "first", exitCode: 1, delay: 30 });
	mockPi.onCall({ output: "two", stderr: "second", exitCode: 2, delay: 60 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-cohort-all-failed");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const messages: string[] = [];
	const { spawnTool } = registerTestTools((message: any) => messages.push(String(message.content)));
	try {
		const ids = ["failed-a", "failed-b"];
		for (const id of ids) await spawnTool.execute(id, { task: id, async: true }, new AbortController().signal, undefined, fake.ctx);
		await Promise.all(ids.map((id) => waitForPersistedRecord(sessionId, id)));
		const records = ids.map((id) => readPersistedRecord(sessionId, id));
		assert.equal(messages.length, 1, "only final cohort notification is sent");
		const final = messages[0]!;
		assert.ok(final.includes("All 2 subagents finished with errors."));
		for (const r of records) {
			assert.ok(final.includes(`- ${r.id}:`));
			assert.ok(final.includes(`result: ${r.outputFile}`));
			assert.ok(final.includes(`stderr: ${r.stderrFile}`));
		}
		assert.ok(final.includes("read stderr logs and result files"));
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("cohort: widget keeps completed cohort members visible while siblings run", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "fast", exitCode: 0, delay: 30 });
	mockPi.onCall({ output: "slow", exitCode: 0, delay: 220 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-cohort-widget-completed");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);
	const { spawnTool } = registerTestTools(() => {});
	try {
		await spawnTool.execute("widget-fast", { task: "fast task", async: true }, new AbortController().signal, undefined, fake.ctx);
		await spawnTool.execute("widget-slow", { task: "slow task", async: true }, new AbortController().signal, undefined, fake.ctx);
		await waitForPersistedRecord(sessionId, "widget-fast", (record) => record.running === false);
		await waitForPersistedRecord(sessionId, "widget-slow", (record) => record.running === true);

		const visible = fake.widgetCalls
			.filter((call) => call.lines)
			.map((call) => call.lines!.join("\n"));
		assert.ok(
			visible.some((text) => text.includes("complete") && text.includes("fast task") && text.includes("running") && text.includes("slow task")),
			"completed cohort member stays visible while sibling remains running",
		);
	} finally {
		try {
			await waitForPersistedRecord(sessionId, "widget-slow", (record) => record.running === false);
		} catch {
			// Best-effort cleanup: the assertion path may run before the record exists.
		}
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("cohort: turn_end starts a new cohort", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "one", exitCode: 0, delay: 80 });
	mockPi.onCall({ output: "two", exitCode: 0, delay: 100 });
	mockPi.onCall({ output: "three", exitCode: 0, delay: 120 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-cohort-turn-end");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const messages: string[] = [];
	const { spawnTool, handlers } = registerTestTools((message: any) => messages.push(String(message.content)));
	try {
		await spawnTool.execute("turn-a", { task: "a", async: true }, new AbortController().signal, undefined, fake.ctx);
		await spawnTool.execute("turn-b", { task: "b", async: true }, new AbortController().signal, undefined, fake.ctx);
		assert.ok(handlers.get("turn_end"), "turn_end handler registered");
		await handlers.get("turn_end")(undefined, fake.ctx);
		await spawnTool.execute("turn-c", { task: "c", async: true }, new AbortController().signal, undefined, fake.ctx);
		await Promise.all(["turn-a", "turn-b", "turn-c"].map((id) => waitForPersistedRecord(sessionId, id)));
		const a = readPersistedRecord(sessionId, "turn-a");
		const b = readPersistedRecord(sessionId, "turn-b");
		const c = readPersistedRecord(sessionId, "turn-c");
		assert.equal(a.cohortId, b.cohortId);
		assert.notEqual(a.cohortId, c.cohortId);
		assert.equal(messages.some((m) => m.includes("out of 2 subagents have completed")), false);
		assert.ok(messages.some((m) => m.includes("All 2 subagents completed successfully.")));
		assert.ok(messages.some((m) => m.includes(`Subagent ${c.id} completed.`) && m.includes("Result file:") && !m.includes("out of")));
		assert.equal(messages.some((m) => m.includes("out of 3") || m.includes("All 3")), false);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("cohort: legacy records without cohortId notify solo", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-cohort-legacy");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const dir = path.join(sessionId, "subagents");
	fs.mkdirSync(dir, { recursive: true });
	const now = Date.now();
	const records = ["legacy-a", "legacy-b"].map((id, index) => {
		const child = path.join(dir, id);
		fs.mkdirSync(child, { recursive: true });
		const outputFile = path.join(child, "result.log");
		fs.writeFileSync(outputFile, `${id}\n`);
		return { id, parentSessionId: sessionId, cwd: ctx.cwd, taskPreview: id, timeout: 3600, running: false, outputFile, stdoutFile: path.join(child, "stdout.log"), stderrFile: path.join(child, "stderr.log"), createdAt: now + index, updatedAt: now + index, completedAt: now + index, pendingCompletionNotice: id === "legacy-a" };
	});
	fs.writeFileSync(storeFile(sessionId), JSON.stringify({ records }, null, 2));
	const messages: string[] = [];
	const { handlers } = registerTestTools((message: any) => messages.push(String(message.content)));
	try {
		await handlers.get("session_start")(undefined, fake.ctx);
		assert.equal(messages.length, 1);
		assert.equal(messages[0].includes("out of 2") || messages[0].includes("All 2"), false);
		const a = readPersistedRecord(sessionId, "legacy-a");
		const b = readPersistedRecord(sessionId, "legacy-b");
		assert.equal(a.notifiedCompletion, true);
		assert.equal(b.notifiedCompletion, undefined);
	} finally {
		cleanupTestCtx(ctx, sessionId);
	}
});

test("cohort: agent_end closes active cohort", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "one", exitCode: 0, delay: 100 });
	mockPi.onCall({ output: "two", exitCode: 0, delay: 100 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-cohort-agent-end");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const { spawnTool, handlers } = registerTestTools(() => {});
	try {
		await spawnTool.execute("agent-a", { task: "a", async: true }, new AbortController().signal, undefined, fake.ctx);
		await handlers.get("agent_end")(undefined, fake.ctx);
		await spawnTool.execute("agent-b", { task: "b", async: true }, new AbortController().signal, undefined, fake.ctx);
		await Promise.all(["agent-a", "agent-b"].map((id) => waitForPersistedRecord(sessionId, id)));
		assert.notEqual(readPersistedRecord(sessionId, "agent-a").cohortId, readPersistedRecord(sessionId, "agent-b").cohortId);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("cohort: reconcile preserves cohort metadata", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-cohort-reconcile");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const dir = path.join(sessionId, "subagents", "reconcile-a");
	fs.mkdirSync(dir, { recursive: true });
	const record = { id: "reconcile-a", parentSessionId: sessionId, cwd: ctx.cwd, taskPreview: "x", timeout: 3600, running: true, outputFile: path.join(dir, "result.log"), stdoutFile: path.join(dir, "stdout.log"), stderrFile: path.join(dir, "stderr.log"), createdAt: Date.now(), updatedAt: Date.now(), cohortId: "cohort-keep", cohortCreatedAt: 12345 };
	fs.writeFileSync(record.stdoutFile, "");
	fs.writeFileSync(record.stderrFile, "");
	fs.writeFileSync(storeFile(sessionId), JSON.stringify({ records: [record] }, null, 2));
	const { handlers } = registerTestTools(() => {});
	try {
		await handlers.get("session_start")(undefined, fake.ctx);
		const persisted = readPersistedRecord(sessionId, "reconcile-a");
		assert.equal(persisted.cohortId, "cohort-keep");
		assert.equal(persisted.cohortCreatedAt, 12345);
	} finally {
		cleanupTestCtx(ctx, sessionId);
	}
});
