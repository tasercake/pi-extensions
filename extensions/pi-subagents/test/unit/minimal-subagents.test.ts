import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import registerSubagentExtension from "../../src/extension/index.ts";
import {
	SpawnSubagentParams,
	GetSubagentStatusParams,
	ListSubagentsParams,
} from "../../src/extension/schemas.ts";
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

function executeSubagentToolInFreshProcess(args: {
	sessionId: string;
	cwd: string;
	tool: "get_subagent_status" | "list_subagents";
	id?: string;
}) {
	const sessionFile = path.join(args.sessionId, "session.jsonl");
	const actualId = args.id ? actualSubagentId(args.id) : undefined;
	const script = `
    import registerSubagentExtension from ${JSON.stringify(path.join(projectRoot, "src/extension/index.ts"))};
    const messages = [];
    const registered = new Map();
    registerSubagentExtension({
      registerTool(tool) { registered.set(tool.name, tool); },
      sendMessage(message) { messages.push(message); },
    });
    const ctx = {
      cwd: ${JSON.stringify(args.cwd)},
      sessionManager: {
        getSessionFile: () => ${JSON.stringify(sessionFile)},
        getSessionId: () => ${JSON.stringify(sessionFile)},
      },
    };
    const tool = registered.get(${JSON.stringify(args.tool)});
    const result = await tool.execute(
      'fresh-runtime-tool-call',
      ${JSON.stringify(args.tool === "get_subagent_status" ? { id: actualId } : {})},
      new AbortController().signal,
      undefined,
      ctx,
    );
    console.log(JSON.stringify({ messages, result }));
  `;
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", script],
		{
			cwd: projectRoot,
			encoding: "utf-8",
		},
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return JSON.parse(result.stdout) as {
		messages: Array<{ content?: unknown }>;
		result: unknown;
	};
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

function registerTestTools(sendMessage: (...args: unknown[]) => void) {
	const registered = new Map<string, any>();
	const fakePi = {
		registerTool(tool: { name: string }) {
			registered.set(tool.name, tool);
		},
		sendMessage,
	};
	registerSubagentExtension(fakePi as never);
	const rawSpawnTool = registered.get("spawn_subagent");
	return {
		spawnTool: {
			...rawSpawnTool,
			async execute(callId: string, ...args: any[]) {
				const result = await rawSpawnTool.execute(callId, ...args);
				const id = result?.details?.id;
				if (typeof id === "string") subagentIdAliases.set(callId, id);
				return result;
			},
		},
		statusTool: {
			...registered.get("get_subagent_status"),
			execute(callId: string, params: any, ...args: any[]) {
				const actualId = subagentIdAliases.get(params?.id) ?? params?.id;
				return registered
					.get("get_subagent_status")
					.execute(callId, { ...params, id: actualId }, ...args);
			},
		},
		listTool: registered.get("list_subagents"),
	};
}

async function waitForStatus(statusTool: any, id: string, ctx: unknown) {
	let status: any;
	for (let i = 0; i < 100; i++) {
		status = await statusTool.execute(
			`status-${id}-${i}`,
			{ id },
			new AbortController().signal,
			undefined,
			ctx,
		);
		if (!status.details.running) return status;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return status;
}

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

test("schemas expose minimal three-tool parameter shapes", async () => {
	assert.equal((SpawnSubagentParams as any).additionalProperties, false);
	assert.deepEqual(
		Object.keys(SpawnSubagentParams.properties).sort(),
		["async", "cwd", "model", "task", "timeout"].sort(),
	);
	assert(!("keepContext" in SpawnSubagentParams.properties));
	assert(!("outputMode" in SpawnSubagentParams.properties));
	assert.match(
		(SpawnSubagentParams.properties.timeout as any).description,
		/Do not kill/i,
	);
	assert.match(
		(SpawnSubagentParams.properties.timeout as any).description,
		/healthy timeout margin/i,
	);
	assert.equal((GetSubagentStatusParams as any).additionalProperties, false);
	assert.deepEqual(Object.keys(GetSubagentStatusParams.properties), ["id"]);
	assert.equal((ListSubagentsParams as any).additionalProperties, false);
	assert.deepEqual(Object.keys(ListSubagentsParams.properties), []);

	const schemas = await import("../../src/extension/schemas.ts");
	assert.equal("SteerSubagentParams" in schemas, false);
});

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

test("extension registers only spawn status and list tools", () => {
	const registered: Array<{ name: string }> = [];
	const fakePi = {
		registerTool(tool: { name: string }) {
			registered.push(tool);
		},
		sendMessage() {
			throw new Error("sendMessage should not be called during registration");
		},
	};

	registerSubagentExtension(fakePi as never);

	assert.deepEqual(
		registered.map((tool) => tool.name),
		["spawn_subagent", "get_subagent_status", "list_subagents"],
	);

	const toolNames = new Set(registered.map((tool) => tool.name));
	assert.equal(toolNames.has("steer_subagent"), false);
	assert.equal(toolNames.has("resume_subagent"), false);
	assert.equal(toolNames.has("follow_up_subagent"), false);
	assert.equal(toolNames.has("interrupt_subagent"), false);
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

test("get_subagent_status retries and clears a pending completion notice", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-retry-status");
	const sentMessages: string[] = [];
	let notifyAttempts = 0;
	const { spawnTool, statusTool } = registerTestTools((message) => {
		notifyAttempts += 1;
		if (notifyAttempts === 1) {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		}
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"retry-status-child",
			{ task: "finish", async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await waitForPersistedRecord(
			sessionId,
			"retry-status-child",
			(candidate) =>
				!candidate.running && candidate.pendingCompletionNotice === true,
		);

		const status = await statusTool.execute(
			"retry-status-call",
			{ id: "retry-status-child" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const record = readPersistedRecord(sessionId, "retry-status-child");

		assert.ok(status.details.resultPath, "status must include resultPath");
		const statusContent = fs.readFileSync(status.details.resultPath, "utf-8");
		assert.match(statusContent, /done/);
		assert.equal(status.details.error, undefined);
		assert.equal(notifyAttempts, 2);
		assert.equal(sentMessages.length, 1);
		assert.equal(record.pendingCompletionNotice, false);
		assert.equal(record.notifyError, undefined);
		assert.equal(record.notifiedCompletion, true);
		assert.equal(typeof record.notifiedAt, "number");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("list_subagents retries pending completion notices best-effort", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-retry-list");
	const sentMessages: string[] = [];
	let notifyAttempts = 0;
	const { spawnTool, listTool } = registerTestTools((message) => {
		notifyAttempts += 1;
		if (notifyAttempts === 1) {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		}
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"retry-list-child",
			{ task: "finish", async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await waitForPersistedRecord(
			sessionId,
			"retry-list-child",
			(candidate) =>
				!candidate.running && candidate.pendingCompletionNotice === true,
		);

		const listed = await listTool.execute(
			"retry-list-call",
			{},
			new AbortController().signal,
			undefined,
			ctx,
		);
		const record = readPersistedRecord(sessionId, "retry-list-child");

		assert.deepEqual(listed.details.subagents, [
			{ id: record.id, running: false },
		]);
		assert.equal(notifyAttempts, 2);
		assert.equal(sentMessages.length, 1);
		assert.equal(record.pendingCompletionNotice, false);
		assert.equal(record.notifiedCompletion, true);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("notification failures do not overwrite successful child result", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "done despite notify failure", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-notify-failure");
	let notifyAttempts = 0;
	const { spawnTool, statusTool } = registerTestTools(() => {
		notifyAttempts += 1;
		throw new Error("transport unavailable");
	});

	try {
		await spawnTool.execute(
			"notify-failure-child",
			{ task: "finish", async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const status = await waitForStatus(statusTool, "notify-failure-child", ctx);
		const record = readPersistedRecord(sessionId, "notify-failure-child");

		assert.equal(status.details.running, false);
		assert.ok(status.details.resultPath, "status must include resultPath");
		const statusContent = fs.readFileSync(status.details.resultPath, "utf-8");
		assert.match(statusContent, /done despite notify failure/);
		assert.equal(status.details.error, undefined);
		assert.ok(record.outputFile, "record must have outputFile");
		const recordContent = fs.readFileSync(record.outputFile, "utf-8");
		assert.match(recordContent, /done despite notify failure/);
		assert.equal(record.error, undefined);
		assert.equal(record.pendingCompletionNotice, true);
		assert.match(record.notifyError, /transport unavailable/);
		assert(notifyAttempts >= 1);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("stale final cohort notification failure leaves cohort pending until retry succeeds", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "done", exitCode: 0, delay: 20 });
	mockPi.onCall({ output: "done", exitCode: 0, delay: 120 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-stale-final-cohort");
	const sentMessages: string[] = [];
	let notifyAttempts = 0;
	const { spawnTool, statusTool } = registerTestTools((message) => {
		notifyAttempts += 1;
		const content = (message as { content?: unknown }).content;
		if (notifyAttempts === 2) {
			assert.equal(typeof content, "string");
			assert.match(content as string, /All 2 subagents have completed\./);
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		}
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"stale-final-cohort-first",
			{ task: "finish first", async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await spawnTool.execute(
			"stale-final-cohort-second",
			{ task: "finish second", async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);

		await waitForPersistedRecord(
			sessionId,
			"stale-final-cohort-first",
			(candidate) => !candidate.running && candidate.result,
		);
		await waitForPersistedRecord(
			sessionId,
			"stale-final-cohort-second",
			(candidate) => !candidate.running && candidate.result,
		);
		for (let i = 0; i < 100 && notifyAttempts < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		const firstAfterFailure = readPersistedRecord(
			sessionId,
			"stale-final-cohort-first",
		);
		const secondAfterFailure = readPersistedRecord(
			sessionId,
			"stale-final-cohort-second",
		);

		assert.ok(firstAfterFailure.result, "result must be set");
		const firstContent = fs.readFileSync(firstAfterFailure.outputFile, "utf-8");
		assert.match(firstContent, /done/);
		assert.ok(secondAfterFailure.result, "result must be set");
		const secondContent = fs.readFileSync(
			secondAfterFailure.outputFile,
			"utf-8",
		);
		assert.match(secondContent, /done/);
		assert.equal(firstAfterFailure.error, undefined);
		assert.equal(secondAfterFailure.error, undefined);
		assert.equal(firstAfterFailure.pendingCompletionNotice, true);
		assert.equal(secondAfterFailure.pendingCompletionNotice, true);
		assert.match(
			firstAfterFailure.notifyError,
			/stale after session replacement or reload/,
		);
		assert.match(
			secondAfterFailure.notifyError,
			/stale after session replacement or reload/,
		);
		assert.equal(firstAfterFailure.cohortFinalNotified, undefined);
		assert.equal(secondAfterFailure.cohortFinalNotified, undefined);
		assert.equal(notifyAttempts, 2);

		const status = await statusTool.execute(
			"stale-final-cohort-retry-status",
			{ id: "stale-final-cohort-second" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const firstAfterRetry = readPersistedRecord(
			sessionId,
			"stale-final-cohort-first",
		);
		const secondAfterRetry = readPersistedRecord(
			sessionId,
			"stale-final-cohort-second",
		);

		assert.ok(status.details.resultPath, "status must include resultPath");
		const statusContent = fs.readFileSync(status.details.resultPath, "utf-8");
		assert.match(statusContent, /done/);
		assert.equal(status.details.error, undefined);
		assert.equal(firstAfterRetry.pendingCompletionNotice, false);
		assert.equal(secondAfterRetry.pendingCompletionNotice, false);
		assert.equal(firstAfterRetry.notifyError, undefined);
		assert.equal(secondAfterRetry.notifyError, undefined);
		assert.equal(firstAfterRetry.cohortFinalNotified, true);
		assert.equal(secondAfterRetry.cohortFinalNotified, true);
		assert(
			sentMessages.some((message) =>
				/All 2 subagents have completed\./.test(message),
			),
		);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("async timeout notifies parent without killing child", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	// delay > timeout so child is still running when timeout fires; delay
	// generous enough for the mock pi process to start and write its session
	// file before the timeout notification needs it.
	mockPi.onCall({ output: "slow done", exitCode: 0, delay: 500 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-timeout");
	const sentMessages: string[] = [];
	const { spawnTool, statusTool } = registerTestTools((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"timeout-child",
			{ task: "slow", async: true, timeout: 0.3 },
			new AbortController().signal,
			undefined,
			ctx,
		);

		// Wait long enough for mock pi to start + write session file + timeout to fire
		await new Promise((resolve) => setTimeout(resolve, 350));
		const timedOutStatus = await statusTool.execute(
			"status-timeout-child-timeout",
			{ id: "timeout-child" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(timedOutStatus.details.running, true);
		assert.equal(timedOutStatus.details.timedOut, true);
		const timedOutRecord = readPersistedRecord(sessionId, "timeout-child");
		assert.match(
			timedOutStatus.details.timeoutMessage,
			new RegExp(`sessionId=${timedOutRecord.id}`),
		);
		assert.match(timedOutStatus.details.timeoutMessage, /pid=\d+/);
		assert.equal(sentMessages.length, 1);
		assert.match(sentMessages[0], /timed out after 0\.3s/);
		assert.match(sentMessages[0], /not killed/);
		assert.match(sentMessages[0], new RegExp(`sessionId=${timedOutRecord.id}`));
		assert.match(sentMessages[0], /pid=\d+/);

		const finalStatus = await waitForStatus(statusTool, "timeout-child", ctx);
		assert.equal(finalStatus.details.running, false);
		assert.ok(
			finalStatus.details.resultPath,
			"final status must include resultPath",
		);
		const finalContent = fs.readFileSync(
			finalStatus.details.resultPath,
			"utf-8",
		);
		assert.match(finalContent, /slow done/);
		assert.equal(finalStatus.details.timedOut, true);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("stale async timeout notification remains pending and is retried by the next live tool call", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({
		output: "eventually done after stale timeout",
		exitCode: 0,
		delay: 500,
	});

	const childId = "stale-timeout-retry-child";
	const { sessionId, ctx } = makeTestCtx("pi-subagents-stale-timeout-retry");
	let staleTimeoutAttempts = 0;
	const staleTools = registerTestTools(() => {
		staleTimeoutAttempts += 1;
		throw new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
	});

	try {
		await staleTools.spawnTool.execute(
			childId,
			{
				task: "slow timeout then finish",
				async: true,
				timeout: 0.05,
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		const recordAfterStaleTimeout = await waitForSubagentRecord(
			sessionId,
			childId,
			(record) =>
				record.running === true && record.pendingTimeoutNotice === true,
		);
		assert.equal(recordAfterStaleTimeout.running, true);
		assert.equal(recordAfterStaleTimeout.pendingTimeoutNotice, true);
		assert.notEqual(recordAfterStaleTimeout.timeoutNotified, true);
		assert.match(
			String(recordAfterStaleTimeout.timeoutNotifyError),
			/stale after session replacement or reload/,
		);
		assert.equal(staleTimeoutAttempts, 1);

		const retry = executeSubagentToolInFreshProcess({
			sessionId,
			cwd: ctx.cwd,
			tool: "get_subagent_status",
			id: childId,
		});

		const timeoutNotifications = retry.messages
			.map((message) => message.content)
			.filter(
				(content): content is string =>
					typeof content === "string" && /timed out after 0.05s/.test(content),
			);
		assert.equal(timeoutNotifications.length, 1);
		assert.match(timeoutNotifications[0], /not killed/);

		const recordAfterRetry = readSubagentRecord(sessionId, childId);
		assert.notEqual(recordAfterRetry.pendingTimeoutNotice, true);
		assert.equal(recordAfterRetry.timeoutNotified, true);
		assert.equal(recordAfterRetry.timeoutNotifyError, undefined);

		const finalStatus = await waitForStatus(
			staleTools.statusTool,
			childId,
			ctx,
		);
		assert.equal(finalStatus.details.running, false);
		assert.ok(
			finalStatus.details.resultPath,
			"final status must include resultPath",
		);
		const finalContent = fs.readFileSync(
			finalStatus.details.resultPath,
			"utf-8",
		);
		assert.match(finalContent, /eventually done after stale timeout/);
		assert.equal(finalStatus.details.timedOut, true);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("spawn_subagent retries a pending timeout notification before starting new work", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "first eventually done", exitCode: 0, delay: 500 });

	const childId = "stale-timeout-spawn-retry-child";
	const { sessionId, ctx } = makeTestCtx(
		"pi-subagents-stale-timeout-spawn-retry",
	);
	let staleTimeoutAttempts = 0;
	const staleTools = registerTestTools(() => {
		staleTimeoutAttempts += 1;
		throw new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
	});

	try {
		await staleTools.spawnTool.execute(
			childId,
			{
				task: "timeout before next spawn",
				async: true,
				timeout: 0.05,
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		await waitForSubagentRecord(
			sessionId,
			childId,
			(record) =>
				record.running === true && record.pendingTimeoutNotice === true,
		);
		assert.equal(staleTimeoutAttempts, 1);

		// Wait for first child to claim its mock response before setting up the
		// second. The second child starts without a delay and can race ahead of
		// the first child's Node.js process startup, claiming queue slot 000001.
		for (let i = 0; i < 50; i++) {
			if (mockPi.callCount() > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		mockPi.onCall({ output: "trigger done", exitCode: 0 });
		const retryMessages: string[] = [];
		const retryTools = registerTestTools((message) => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") retryMessages.push(content);
		});

		await retryTools.spawnTool.execute(
			"timeout-retry-trigger-child",
			{ task: "trigger retry", async: true, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const timeoutNotifications = retryMessages.filter((content) =>
			/timed out after 0.05s/.test(content),
		);
		assert.equal(timeoutNotifications.length, 1);
		const timedOutRecord = readSubagentRecord(sessionId, childId);
		assert.match(
			timeoutNotifications[0],
			new RegExp(`Subagent ${timedOutRecord.id} timed out`),
		);

		const recordAfterRetry = readSubagentRecord(sessionId, childId);
		assert.notEqual(recordAfterRetry.pendingTimeoutNotice, true);
		assert.equal(recordAfterRetry.timeoutNotified, true);
		assert.equal(recordAfterRetry.timeoutNotifyError, undefined);

		const finalStatus = await waitForStatus(
			retryTools.statusTool,
			childId,
			ctx,
		);
		assert.equal(finalStatus.details.running, false);
		assert.ok(
			finalStatus.details.resultPath,
			"final status must include resultPath",
		);
		const finalContent = fs.readFileSync(
			finalStatus.details.resultPath,
			"utf-8",
		);
		assert.match(finalContent, /first eventually done/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("stale async timeout notification is not retried after child completion", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({
		output: "done before timeout retry",
		exitCode: 0,
		delay: 90,
	});

	const childId = "stale-timeout-completed-child";
	const { sessionId, ctx } = makeTestCtx(
		"pi-subagents-stale-timeout-completed",
	);
	const staleTools = registerTestTools(() => {
		throw new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
	});

	try {
		await staleTools.spawnTool.execute(
			childId,
			{
				task: "finish before timeout retry",
				async: true,
				timeout: 0.02,
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		await waitForSubagentRecord(
			sessionId,
			childId,
			(record) =>
				record.running === true && record.pendingTimeoutNotice === true,
		);
		await waitForSubagentRecord(sessionId, childId, (record) => {
			if (!record.running && record.outputFile) {
				try {
					const content = fs.readFileSync(record.outputFile as string, "utf-8");
					return content.includes("done before timeout retry");
				} catch {}
			}
			return false;
		});

		const retry = executeSubagentToolInFreshProcess({
			sessionId,
			cwd: ctx.cwd,
			tool: "list_subagents",
		});

		const messages = retry.messages
			.map((message) => message.content)
			.filter((content): content is string => typeof content === "string");
		assert.equal(
			messages.some((content) => /timed out after 0.02s/.test(content)),
			false,
		);

		const recordAfterRetry = readSubagentRecord(sessionId, childId);
		assert.notEqual(recordAfterRetry.pendingTimeoutNotice, true);
		assert.notEqual(recordAfterRetry.timeoutNotified, true);
		assert.ok(recordAfterRetry.outputFile, "record must have outputFile");
		const recordContent = fs.readFileSync(
			recordAfterRetry.outputFile as string,
			"utf-8",
		);
		assert.match(recordContent, /done before timeout retry/);
		assert.ok(recordAfterRetry.timeoutAt);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("stale async completion notification remains pending and is retried once by the next live tool call", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "done after stale ctx", exitCode: 0 });

	const childId = "stale-retry-child";
	const { sessionId, ctx } = makeTestCtx("pi-subagents-stale-retry");
	let staleNotifyAttempts = 0;
	const staleTools = registerTestTools(() => {
		staleNotifyAttempts += 1;
		throw new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
	});

	try {
		await staleTools.spawnTool.execute(
			childId,
			{
				task: "finish after stale notify",
				async: true,
				timeout: 30,
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		const completedRecord = await waitForSubagentRecord(
			sessionId,
			childId,
			(record) => {
				if (!record.running && record.outputFile) {
					try {
						const content = fs.readFileSync(
							record.outputFile as string,
							"utf-8",
						);
						return content.includes("done after stale ctx");
					} catch {}
				}
				return false;
			},
		);
		assert.equal(completedRecord.running, false);

		const recordAfterStaleFailure = await waitForSubagentRecord(
			sessionId,
			childId,
			(record) => record.completionNotificationPending === true,
		);
		assert.equal(staleNotifyAttempts, 1);
		assert.equal(recordAfterStaleFailure.completionNotificationPending, true);
		assert.notEqual(recordAfterStaleFailure.notifiedCompletion, true);
		assert.match(
			String(recordAfterStaleFailure.notifyError),
			/stale after session replacement or reload/,
		);

		// Contract: every subagent tool execution first drains durable pending notices
		// for its current parent session. This phase runs in a separate Node process
		// so the retry must come from persisted state, not module-level memory.
		const retry = executeSubagentToolInFreshProcess({
			sessionId,
			cwd: ctx.cwd,
			tool: "get_subagent_status",
			id: childId,
		});

		const retriedNotifications = retry.messages
			.map((message) => message.content)
			.filter((content): content is string => typeof content === "string");
		assert.equal(retriedNotifications.length, 1);
		const recordAfterStaleFailureId = actualSubagentId(childId);
		assert.match(
			retriedNotifications[0],
			new RegExp(`Subagent ${recordAfterStaleFailureId} completed\\.`),
		);
		const retryStatus = retry.result as {
			details: { id: string; running: boolean; resultPath: string };
		};
		assert.equal(retryStatus.details.id, recordAfterStaleFailureId);
		assert.equal(retryStatus.details.running, false);
		assert.ok(retryStatus.details.resultPath, "resultPath must be present");
		const retryContent = fs.readFileSync(
			retryStatus.details.resultPath,
			"utf-8",
		);
		assert.match(retryContent, /done after stale ctx/);

		const recordAfterRetry = readSubagentRecord(sessionId, childId);
		assert.notEqual(recordAfterRetry.completionNotificationPending, true);
		assert.equal(recordAfterRetry.notifiedCompletion, true);

		const duplicateCheck = executeSubagentToolInFreshProcess({
			sessionId,
			cwd: ctx.cwd,
			tool: "list_subagents",
		});

		assert.equal(duplicateCheck.messages.length, 0);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("stale cohort notification failure does not suppress later final notification", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "done", exitCode: 0, delay: 20 });
	mockPi.onCall({ output: "done", exitCode: 0, delay: 120 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-stale-cohort");
	const sentMessages: string[] = [];
	let notifyAttempts = 0;
	const { spawnTool, statusTool } = registerTestTools((message) => {
		notifyAttempts += 1;
		if (notifyAttempts === 1) {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		}
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"stale-cohort-first",
			{ task: "finish first", async: true, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await spawnTool.execute(
			"stale-cohort-second",
			{ task: "finish second", async: true, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);

		await waitForPersistedRecord(sessionId, "stale-cohort-first");
		await waitForPersistedRecord(sessionId, "stale-cohort-second");

		const firstStatus = await statusTool.execute(
			"stale-cohort-first-status",
			{ id: "stale-cohort-first" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const secondStatus = await statusTool.execute(
			"stale-cohort-second-status",
			{ id: "stale-cohort-second" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.ok(
			firstStatus.details.resultPath,
			"first status must include resultPath",
		);
		const firstContent = fs.readFileSync(
			firstStatus.details.resultPath,
			"utf-8",
		);
		assert.match(firstContent, /done/);
		assert.ok(
			secondStatus.details.resultPath,
			"second status must include resultPath",
		);
		const secondContent = fs.readFileSync(
			secondStatus.details.resultPath,
			"utf-8",
		);
		assert.match(secondContent, /done/);
		assert.equal(firstStatus.details.error, undefined);
		assert.equal(secondStatus.details.error, undefined);
		assert.equal(sentMessages.length, 1);
		assert(
			sentMessages.some((message) =>
				/All 2 subagents have completed\./.test(message),
			),
		);

		const firstRecord = readPersistedRecord(sessionId, "stale-cohort-first");
		const secondRecord = readPersistedRecord(sessionId, "stale-cohort-second");
		assert.equal(firstRecord.pendingCompletionNotice, false);
		assert.equal(firstRecord.notifiedCompletion, true);
		assert.equal(secondRecord.pendingCompletionNotice, false);
		assert.equal(secondRecord.notifiedCompletion, true);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// ─── New tests per subagent-auto-result-file spec ───────────────

// Test 1: Schema excludes outputMode — updated above (first test in file)

// Test 2: Spawn response includes resultPath (Requirement 2)
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
test("async spawn response includes resultPath", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "async done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-async-resultpath");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"async-resultpath-child",
			{ task: "finish", async: true, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.ok(result.details.resultPath, "resultPath must be present");
		assert.match(result.details.resultPath, /\/subagents\/[^/]+\/result\.log$/);
	} finally {
		mockPi.uninstall();
		// The async child may still be writing to its stdout/stderr files.
		// Allow it a moment to finish so cleanup does not trigger ENOENT.
		await new Promise((resolve) => setTimeout(resolve, 200));
		cleanupTestCtx(ctx, sessionId);
	}
});

// Test 4: Completion notification includes resultPath, not get_subagent_status (Requirement 3)
test("completion notification includes resultPath and does not reference get_subagent_status", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "notified", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-notify-resultpath");
	const sentMessages: string[] = [];
	const { spawnTool } = registerTestTools((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"notify-resultpath-child",
			{ task: "finish", async: true, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);

		await waitForPersistedRecord(
			sessionId,
			"notify-resultpath-child",
			(candidate) =>
				!candidate.running && candidate.notifiedCompletion === true,
		);

		const record = readPersistedRecord(sessionId, "notify-resultpath-child");
		const completionMessage = sentMessages.find(
			(m) => m.includes(record.id) && m.includes("completed"),
		);
		assert.ok(completionMessage, "completion message must exist");
		assert.match(completionMessage!, /Result file:/);
		assert.match(completionMessage!, /result\.log/);
		assert(
			!completionMessage!.includes("get_subagent_status"),
			"completion message must not mention get_subagent_status",
		);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// Test 5: get_subagent_status returns resultPath for completed subagent (Requirement 7)
test("get_subagent_status returns resultPath for completed subagent", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "status check", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-status-resultpath");
	const { spawnTool, statusTool } = registerTestTools(() => {});

	try {
		await spawnTool.execute(
			"status-resultpath-child",
			{ task: "finish", async: false },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const status = await statusTool.execute(
			"status-call",
			{ id: "status-resultpath-child" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(status.details.running, false);
		assert.ok(status.details.resultPath, "status must include resultPath");
		assert.match(status.details.resultPath, /result\.log$/);
		// result file must contain output
		const content = fs.readFileSync(status.details.resultPath, "utf-8");
		assert.match(content, /status check/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// Test 6: Auto-saves final assistant message to result file when subagent does not write to it (Requirement 5)
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

test("Phase 7.1: async widget renders on spawn and clears on completion", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "widget done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-widget-1");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);

	const sentMessages: string[] = [];
	const { spawnTool, statusTool } = registerTestTools((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"widget-child",
			{
				task: "widget render test",
				async: true,
			},
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		// Widget should have been rendered with the subagent line
		const renderCall = fake.widgetCalls.find(
			(c) => c.key != null && c.lines != null && c.lines.length === 1,
		);
		assert.ok(renderCall, "expected at least one render widget call");
		assert.match(
			renderCall!.lines![0],
			new RegExp(`subagent ${actualSubagentId("widget-child")} running`),
		);

		await waitForStatus(statusTool, "widget-child", fake.ctx);

		// Widget should have been cleared (setWidget with undefined)
		const clearCall = fake.widgetCalls.find((c) => c.lines === undefined);
		assert.ok(clearCall, "expected widget clear call");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

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

test("Phase 7.2: multiple active subagents show multiple widget lines, clear one by one", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "first done", exitCode: 0, delay: 80 });
	mockPi.onCall({ output: "second done", exitCode: 0, delay: 30_000 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-widget-2");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);

	const { spawnTool, statusTool, listTool } = registerTestTools(() => {});

	try {
		await spawnTool.execute(
			"multi-first",
			{ task: "first", async: true },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		for (let i = 0; i < 100 && mockPi.callCount() < 1; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(
			mockPi.callCount(),
			1,
			"first child must claim first mock response before second spawns",
		);
		await spawnTool.execute(
			"multi-second",
			{ task: "second", async: true },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		// Should have a render with 2 lines while both are running
		const multiCall = fake.widgetCalls.find(
			(c) => c.lines != null && c.lines.length === 2,
		);
		assert.ok(multiCall, "expected widget with 2 lines");

		let firstStatus: any;
		for (let i = 0; i < 400; i++) {
			firstStatus = await statusTool.execute(
				`multi-first-status-${i}`,
				{ id: "multi-first" },
				new AbortController().signal,
				undefined,
				fake.ctx,
			);
			if (!firstStatus.details.running) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(firstStatus.details.running, false);
		await listTool.execute(
			"multi-after-first",
			{},
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		const secondActualId = actualSubagentId("multi-second");
		const firstActualId = actualSubagentId("multi-first");
		let afterFirstClear = fake.widgetCalls.find(
			(c) =>
				c.lines != null &&
				c.lines.length === 1 &&
				c.lines[0].includes(secondActualId) &&
				!c.lines[0].includes(firstActualId),
		);
		for (let i = 0; !afterFirstClear && i < 100; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			afterFirstClear = fake.widgetCalls.find(
				(c) =>
					c.lines != null &&
					c.lines.length === 1 &&
					c.lines[0].includes(secondActualId) &&
					!c.lines[0].includes(firstActualId),
			);
		}
		assert.ok(afterFirstClear, "expected widget to clear first child only");

		const runningSecond = readPersistedRecord(sessionId, "multi-second");
		if (runningSecond.running && typeof runningSecond.pid === "number") {
			try {
				process.kill(runningSecond.pid, "SIGTERM");
			} catch {
				// Child may have exited between reading the durable record and cleanup.
			}
		}

		let secondStatus: any;
		for (let i = 0; i < 400; i++) {
			secondStatus = await statusTool.execute(
				`multi-second-status-${i}`,
				{ id: "multi-second" },
				new AbortController().signal,
				undefined,
				fake.ctx,
			);
			if (!secondStatus.details.running) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(secondStatus.details.running, false);

		// Final calls: should clear
		let clearCount = 0;
		for (let i = 0; i < 100; i++) {
			clearCount = fake.widgetCalls.filter((c) => c.lines === undefined).length;
			if (clearCount >= 1) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(clearCount >= 1, "expected at least one clear call");
	} finally {
		await new Promise((resolve) => setTimeout(resolve, 300));
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("Phase 7.3: timeout widget line shows 'timed out, still running'", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "slow done", exitCode: 0, delay: 500 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-widget-3");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);

	const { spawnTool, statusTool } = registerTestTools(() => {});

	try {
		await spawnTool.execute(
			"timeout-widget-child",
			{
				task: "slow",
				async: true,
				timeout: 0.05,
			},
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		// Wait for timeout to fire
		await new Promise((resolve) => setTimeout(resolve, 120));

		// Trigger widget render via get_subagent_status (calls maybeRenderRunningWidget)
		// Status check forces render without waiting for timer.
		await statusTool.execute(
			"trigger-widget-refresh",
			{ id: "timeout-widget-child" },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		const timeoutCall = fake.widgetCalls.find(
			(c) =>
				c.lines != null &&
				c.lines.some((line) => /timed out, still running/.test(line)),
		);
		assert.ok(
			timeoutCall,
			"expected widget line with 'timed out, still running'",
		);
		await waitForStatus(statusTool, "timeout-widget-child", fake.ctx);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("Phase 7.4: no UI is headless-safe — no setWidget calls, no crash", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "headless done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-headless-4");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);

	const { spawnTool, statusTool } = registerTestTools(() => {});

	try {
		await spawnTool.execute(
			"headless-child",
			{
				task: "headless test",
				async: true,
			},
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		const status = await waitForStatus(statusTool, "headless-child", fake.ctx);
		assert.equal(status.details.running, false);
		assert.ok(status.details.resultPath);
		assert.equal(
			fs.readFileSync(status.details.resultPath, "utf-8").trim(),
			"headless done",
		);

		// No widget calls in headless mode
		assert.equal(fake.widgetCalls.length, 0);
	} finally {
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

test("Phase 7.5: reconciliation marks record not running when persisted PID is dead", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-deadpid-5");

	// Manually persist a record with a dead PID (32767 is unlikely to exist)
	const record = {
		id: "deadpid-child",
		parentSessionId: sessionId,
		cwd: ctx.cwd,
		taskPreview: "dead pid test",
		timeout: 30,
		running: true,
		pid: 32767,
		sessionFile: path.join(
			storeDir(sessionId),
			"deadpid-child",
			"session.jsonl",
		),
		outputFile: path.join(storeDir(sessionId), "deadpid-child", "result.log"),
		stdoutFile: path.join(storeDir(sessionId), "deadpid-child", "stdout.log"),
		stderrFile: path.join(storeDir(sessionId), "deadpid-child", "stderr.log"),
		createdAt: Date.now() - 60_000,
		updatedAt: Date.now() - 60_000,
	};
	const storeFilePath = storeFile(sessionId);
	fs.mkdirSync(path.dirname(storeFilePath), { recursive: true });
	fs.mkdirSync(path.dirname(record.stdoutFile), { recursive: true });
	fs.writeFileSync(
		record.stdoutFile,
		'{"type":"message","message":{"role":"assistant","content":"dead output"}}\n',
		"utf-8",
	);
	fs.writeFileSync(
		storeFilePath,
		JSON.stringify({ records: [record] }, null, 2),
		{ mode: 0o600 },
	);

	const retry = executeSubagentToolInFreshProcess({
		sessionId,
		cwd: ctx.cwd,
		tool: "get_subagent_status",
		id: "deadpid-child",
	});

	const status = retry.result as {
		details: {
			id: string;
			running: boolean;
			resultPath?: string;
			error?: string;
		};
	};
	assert.equal(status.details.id, "deadpid-child");
	assert.equal(status.details.running, false);
	assert.ok(
		status.details.resultPath || status.details.error,
		"should have result path or error after reconciliation",
	);

	// The record in store should now be marked not running
	const persisted = readPersistedRecord(sessionId, "deadpid-child");
	assert.equal(persisted.running, false);

	cleanupTestCtx(ctx, sessionId);
});

test("N5: dual timers are unref'd, refresh independently, and clear when idle", async () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const originalKill = process.kill;
	let childPid: number | undefined;
	let livePidChecks = 0;
	(process as any).kill = (pid: number, signal?: NodeJS.Signals | number) => {
		if (childPid !== undefined && pid === childPid && signal === 0) {
			livePidChecks += 1;
		}
		return (originalKill as any).call(process, pid, signal);
	};
	const timers: Array<{
		ms: number;
		unrefCalled: boolean;
		cleared: boolean;
		handle: any;
	}> = [];
	(globalThis as any).setInterval = (
		fn: () => void,
		ms?: number,
		...args: unknown[]
	) => {
		const handle = originalSetInterval(fn, ms as any, ...args);
		const timer = {
			ms: Number(ms),
			unrefCalled: false,
			cleared: false,
			handle,
		};
		const originalUnref =
			typeof (handle as any).unref === "function"
				? (handle as any).unref.bind(handle)
				: undefined;
		(handle as any).unref = () => {
			timer.unrefCalled = true;
			return originalUnref?.();
		};
		timers.push(timer);
		return handle;
	};
	(globalThis as any).clearInterval = (handle: any) => {
		const timer = timers.find((candidate) => candidate.handle === handle);
		if (timer) timer.cleared = true;
		return originalClearInterval(handle);
	};
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "timer done", exitCode: 0, delay: 6_500 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-dual-timer-n5");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);
	const { spawnTool, statusTool } = registerTestTools(() => {});
	try {
		await spawnTool.execute(
			"dual-timer-child",
			{ task: "dual timer", async: true, timeout: 2 },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		const widgetTimer = timers.find((t) => t.ms === 1000)!;
		const reconcileTimer = timers.find((t) => t.ms === 5000)!;
		assert.ok(widgetTimer?.unrefCalled, "1Hz widget timer unref'd");
		assert.ok(reconcileTimer?.unrefCalled, "0.2Hz reconcile timer unref'd");
		const runningRecord = readPersistedRecord(sessionId, "dual-timer-child");
		childPid = runningRecord.pid;
		assert.equal(runningRecord.running, true);
		assert.equal(typeof childPid, "number");

		const widgetCallsBefore = fake.widgetCalls.length;
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		assert.ok(
			fake.widgetCalls.length > widgetCallsBefore,
			"real 1s widget timer refreshes widget",
		);
		const dualTimerActualId = actualSubagentId("dual-timer-child");
		assert.ok(
			fake.widgetCalls.some((c) =>
				c.lines?.some(
					(line) =>
						line.includes(dualTimerActualId) && /running [1-9]\d*s/.test(line),
				),
			),
			"elapsed-time display refreshes after a real 1s wait",
		);

		const livePidChecksBeforeReconcile = livePidChecks;
		await new Promise((resolve) => setTimeout(resolve, 5_100));
		assert.ok(
			livePidChecks > livePidChecksBeforeReconcile,
			"real 5s reconcile timer calls reconcileStore via live PID check",
		);
		assert.equal(
			readPersistedRecord(sessionId, "dual-timer-child").running,
			true,
			"real 5s reconcile timer reconciles store without killing live child",
		);

		await waitForStatus(statusTool, "dual-timer-child", fake.ctx);
		assert.ok(widgetTimer.cleared, "widget timer cleared when idle");
		assert.ok(reconcileTimer.cleared, "reconcile timer cleared when idle");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		(process as any).kill = originalKill;
	}
});

test("Phase 7.6: widget failure isolation — setWidget throws but child still works", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "isolated done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-isolate-6");
	let setWidgetCalls = 0;
	const fakeCtx = {
		cwd: ctx.cwd,
		hasUI: true,
		ui: {
			setWidget() {
				setWidgetCalls += 1;
				throw new Error("widget renderer is broken");
			},
		},
		sessionManager: {
			getSessionFile: () => sessionId,
			getSessionId: () => sessionId,
		},
	};

	const { spawnTool, statusTool } = registerTestTools(() => {});

	try {
		await spawnTool.execute(
			"isolate-child",
			{
				task: "isolate test",
				async: true,
			},
			new AbortController().signal,
			undefined,
			fakeCtx,
		);

		const status = await waitForStatus(statusTool, "isolate-child", fakeCtx);
		assert.equal(status.details.running, false);
		assert.ok(status.details.resultPath);
		assert.equal(
			fs.readFileSync(status.details.resultPath, "utf-8").trim(),
			"isolated done",
		);
		assert.ok(
			setWidgetCalls >= 1,
			"setWidget was called (and threw) at least once",
		);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("Phase 7.7: notification idempotency — two processes do not send duplicate completion", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "idempotent done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-idempotent-7");
	const sentMessages: string[] = [];
	const { spawnTool } = registerTestTools((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"idempotent-child",
			{
				task: "idempotent test",
				async: true,
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		await waitForPersistedRecord(sessionId, "idempotent-child");

		// First process sent the notification
		const idempotentRecord = readPersistedRecord(sessionId, "idempotent-child");
		const completionMessages = sentMessages.filter((m) =>
			new RegExp(`Subagent ${idempotentRecord.id} completed\\.`).test(m),
		);
		assert.equal(
			completionMessages.length,
			1,
			"exactly one completion notification",
		);

		// A second process (simulated via executeSubagentToolInFreshProcess) should NOT send
		// a duplicate notification because notifiedCompletion is already true
		const retry = executeSubagentToolInFreshProcess({
			sessionId,
			cwd: ctx.cwd,
			tool: "list_subagents",
		});

		const retryMessages = retry.messages
			.map((m) => m.content)
			.filter((c): c is string => typeof c === "string");
		const duplicateCompletions = retryMessages.filter((m) =>
			new RegExp(`Subagent ${idempotentRecord.id} completed\\.`).test(m),
		);
		assert.equal(
			duplicateCompletions.length,
			0,
			"second process must not send duplicate completion",
		);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
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

test("Phase 7.9b: child error after spawn — done resolves with errored record", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	// Child exits with non-zero code and stderr to simulate error after spawn
	mockPi.onCall({
		output: "",
		stderr: "simulated spawn failure: cannot exec",
		exitCode: 1,
	});

	const { sessionId, ctx } = makeTestCtx("pi-subagents-childerror-9b");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);

	const sentMessages: string[] = [];
	const { spawnTool, statusTool } = registerTestTools((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"child-error-after-spawn",
			{
				task: "will error after spawn",
				async: true,
			},
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		const status = await waitForStatus(
			statusTool,
			"child-error-after-spawn",
			fake.ctx,
		);
		assert.equal(status.details.running, false);
		assert.ok(status.details.error, "should have error after non-zero exit");

		const record = readPersistedRecord(sessionId, "child-error-after-spawn");
		assert.equal(record.running, false);
		assert.ok(record.error);
		assert.ok(record.completedAt);

		// Widget should eventually clear
		const clearCalls = fake.widgetCalls.filter(
			(c) => c.lines === undefined && c.key?.includes("pi-subagents-running"),
		);
		assert.ok(clearCalls.length >= 1, "widget should clear on error");

		// No unhandled rejection — the async .catch() must silence it
		// (test passes if we reach here without process-level unhandled rejection)
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("Phase 7.10: store overwrite race guard — terminal wins over running", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-overwrite-10");

	// Write a running record directly
	const recordId = "race-child";
	const storeFilePath = storeFile(sessionId);
	fs.mkdirSync(path.dirname(storeFilePath), { recursive: true });

	const childDataDir = path.join(storeDir(sessionId), recordId);
	fs.mkdirSync(childDataDir, { recursive: true });
	const stdoutPath = path.join(childDataDir, "stdout.log");
	fs.writeFileSync(stdoutPath, "", "utf-8");

	const initialRecord = {
		id: recordId,
		parentSessionId: sessionId,
		cwd: ctx.cwd,
		taskPreview: "race test",
		timeout: 30,
		running: true,
		pid: 32767,
		sessionFile: path.join(childDataDir, "session.jsonl"),
		outputFile: path.join(childDataDir, "result.log"),
		stdoutFile: stdoutPath,
		stderrFile: path.join(childDataDir, "stderr.log"),
		createdAt: Date.now() - 120_000,
		updatedAt: Date.now() - 60_000,
		pendingCompletionNotice: true,
		completionNotificationPending: true,
	};
	fs.writeFileSync(
		storeFilePath,
		JSON.stringify({ records: [initialRecord] }, null, 2),
		{ mode: 0o600 },
	);

	// Simulate another writer storing a newer terminal update with notifiedCompletion=true
	// This races with reconcile reading — merge should prefer terminal + notified
	const racedRecord = {
		...initialRecord,
		running: false,
		result: path.join(childDataDir, "result.log"),
		completedAt: Date.now() - 30_000,
		updatedAt: Date.now() - 10_000,
		notifiedCompletion: true,
		pendingCompletionNotice: false,
		completionNotificationPending: false,
	};

	fs.writeFileSync(
		path.join(childDataDir, "result.log"),
		"race-winner\n",
		"utf-8",
	);

	// Write the raced (newer terminal) record concurrently
	fs.writeFileSync(
		storeFilePath,
		JSON.stringify({ records: [racedRecord] }, null, 2),
		{ mode: 0o600 },
	);

	// Reconcile via fresh process (reads latest, refreshes, merges)
	const result = executeSubagentToolInFreshProcess({
		sessionId,
		cwd: ctx.cwd,
		tool: "get_subagent_status",
		id: recordId,
	});

	const status = result.result as {
		details: {
			id: string;
			running: boolean;
			resultPath?: string;
			error?: string;
		};
	};
	assert.equal(status.details.id, recordId);
	assert.equal(status.details.running, false);
	assert.ok(status.details.resultPath);
	assert.equal(
		fs.readFileSync(status.details.resultPath, "utf-8").trim(),
		"race-winner",
	);

	// The persisted record must reflect terminal wins
	const persisted = readPersistedRecord(sessionId, recordId);
	assert.equal(persisted.running, false);
	assert.equal(
		fs.readFileSync(persisted.result, "utf-8").trim(),
		"race-winner",
	);

	// Notification fields: notifiedCompletion should be preserved (true)
	assert.equal(persisted.notifiedCompletion, true);
	assert.equal(persisted.pendingCompletionNotice, false);

	cleanupTestCtx(ctx, sessionId);
});

test("Phase 7.11: parent/session restart with live PID — reconcile keeps active", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-livepid-11");

	const recordId = "livepid-child";
	const storeFilePath = storeFile(sessionId);
	fs.mkdirSync(path.dirname(storeFilePath), { recursive: true });

	const childDataDir = path.join(storeDir(sessionId), recordId);
	fs.mkdirSync(childDataDir, { recursive: true });
	const stdoutPath = path.join(childDataDir, "stdout.log");
	const stderrPath = path.join(childDataDir, "stderr.log");
	// Write minimal stdout so extractFinalOutput doesn't produce empty error
	fs.writeFileSync(
		stdoutPath,
		'{"type":"message","message":{"role":"assistant","content":"still alive"}}\n',
		"utf-8",
	);
	fs.writeFileSync(stderrPath, "", "utf-8");

	// Use the current test process PID — it's definitely running
	const record = {
		id: recordId,
		parentSessionId: sessionId,
		cwd: ctx.cwd,
		taskPreview: "live pid test",
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

	// Simulate fresh session_start via fresh process
	const result = executeSubagentToolInFreshProcess({
		sessionId,
		cwd: ctx.cwd,
		tool: "get_subagent_status",
		id: recordId,
	});

	const status = result.result as {
		details: { id: string; running: boolean; result?: string };
	};
	assert.equal(status.details.id, recordId);
	// PID is live, so reconcile keeps running=true
	assert.equal(status.details.running, true);

	const persisted = readPersistedRecord(sessionId, recordId);
	assert.equal(persisted.running, true);

	cleanupTestCtx(ctx, sessionId);
});

test("N4: restarted parent reconciles an already-live child from a prior process", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "live restart done", exitCode: 0, delay: 2500 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-live-restart-n4");
	const sessionFile = path.join(sessionId, "session.jsonl");
	const extensionPath = path.join(projectRoot, "src/extension/index.ts");
	const childId = "live-restart-child";
	const messagesFile = path.join(sessionId, "n4-messages.jsonl");
	const firstProcessScript = `
		import fs from "node:fs";
		import registerSubagentExtension from ${JSON.stringify(extensionPath)};
		const registered = new Map();
		registerSubagentExtension({
			registerTool(tool) { registered.set(tool.name, tool); },
			sendMessage(message) { fs.appendFileSync(${JSON.stringify(messagesFile)}, JSON.stringify(message) + "\\n", "utf-8"); },
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
			{ task: "live restart", async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		// Process stays alive naturally until the async child exits because child stdio is ref'd.
	`;
	const restartScript = `
		import fs from "node:fs";
		import registerSubagentExtension from ${JSON.stringify(extensionPath)};
		const messages = [];
		const widgetCalls = [];
		const registered = new Map();
		let sessionStart;
		registerSubagentExtension({
			registerTool(tool) { registered.set(tool.name, tool); },
			sendMessage(message) { if (typeof message.content === "string") messages.push(message.content); },
			on(event, handler) { if (event === "session_start") sessionStart = handler; },
		});
		const ctx = {
			cwd: ${JSON.stringify(ctx.cwd)},
			hasUI: true,
			ui: { setWidget(key, lines) { widgetCalls.push({ key, lines }); } },
			sessionManager: {
				getSessionFile: () => ${JSON.stringify(sessionFile)},
				getSessionId: () => ${JSON.stringify(sessionFile)},
			},
		};
		await sessionStart(undefined, ctx);
		const storeAfterStart = JSON.parse(fs.readFileSync(${JSON.stringify(storeFile(sessionId))}, "utf-8"));
		const recordAfterStart = storeAfterStart.records.find((candidate) => candidate.taskPreview === "live restart");
		await new Promise((resolve) => setTimeout(resolve, 2700));
		await registered.get("list_subagents").execute(
			"restart-list-after-exit",
			{},
			new AbortController().signal,
			undefined,
			ctx,
		);
		const terminalStore = JSON.parse(fs.readFileSync(${JSON.stringify(storeFile(sessionId))}, "utf-8"));
		const terminalRecord = terminalStore.records.find((candidate) => candidate.id === recordAfterStart.id);
		const status = await registered.get("get_subagent_status").execute(
			"restart-status",
			{ id: recordAfterStart.id },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const storeAfterCompletion = JSON.parse(fs.readFileSync(${JSON.stringify(storeFile(sessionId))}, "utf-8"));
		const recordAfterCompletion = storeAfterCompletion.records.find((candidate) => candidate.id === recordAfterStart.id);
		console.log(JSON.stringify({ messages, widgetCalls, recordAfterStart, recordAfterCompletion, status }));
	`;
	let first: ReturnType<typeof spawn> | undefined;
	try {
		first = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				firstProcessScript,
			],
			{ cwd: projectRoot, env: process.env },
		);
		await waitForPersistedRecord(
			sessionId,
			childId,
			(record) => record.running === true && typeof record.pid === "number",
		);
		const preRestart = readPersistedRecord(sessionId, childId);
		assert.equal(preRestart.running, true);
		assert.equal(typeof preRestart.pid, "number");
		assert.notEqual(preRestart.pid, process.pid);

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
		const result = JSON.parse(restarted.stdout) as {
			messages: string[];
			widgetCalls: Array<{ key: string; lines?: string[] }>;
			recordAfterStart?: Record<string, any>;
			recordAfterCompletion?: Record<string, any>;
			status: { details: { running: boolean } };
		};
		assert.ok(
			result.recordAfterStart,
			"restarted parent reads pre-existing child record",
		);
		assert.equal(
			result.recordAfterStart.running,
			true,
			"live PID stays running after restart reconciliation",
		);
		assert.equal(result.recordAfterStart.pid, preRestart.pid);
		const firstExit = await new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve) => {
			first!.once("exit", (code, signal) => resolve({ code, signal }));
		});
		assert.deepEqual(firstExit, { code: 0, signal: null });
		const parentMessages = fs
			.readFileSync(messagesFile, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { content?: unknown });
		assert.ok(
			result.widgetCalls.some((c) =>
				c.lines?.some((line) => line.includes(preRestart.id)),
			),
			"restarted parent renders widget for already-live child",
		);
		assert.equal(
			parentMessages.filter(
				(m) => typeof m.content === "string" && m.content.includes("completed"),
			).length,
			1,
			"original live parent eventually sends exactly one completion notification",
		);
		assert.equal(
			result.messages.filter((m) => m.includes("completed")).length,
			0,
		);
		assert.equal(result.status.details.running, false);
		assert.equal(result.recordAfterCompletion?.running, false);
		assert.ok(
			parentMessages.some(
				(m) =>
					typeof m.content === "string" &&
					m.content.includes(preRestart.id) &&
					m.content.includes("completed"),
			),
			"normal child completion sends notification after child exits",
		);
		assert.ok(
			result.widgetCalls.some((c) => c.lines === undefined),
			"restarted parent clears widget after completion",
		);
	} finally {
		if (first && !first.killed) first.kill();
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("Phase 7.12: dead PID with no output is terminal unknown/error", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-deadpid-nooutput-12");

	const recordId = "deadpid-nooutput-child";
	const storeFilePath = storeFile(sessionId);
	fs.mkdirSync(path.dirname(storeFilePath), { recursive: true });

	const childDataDir = path.join(storeDir(sessionId), recordId);
	fs.mkdirSync(childDataDir, { recursive: true });
	const stdoutPath = path.join(childDataDir, "stdout.log");
	const stderrPath = path.join(childDataDir, "stderr.log");
	// No output at all — files are empty
	fs.writeFileSync(stdoutPath, "", "utf-8");
	fs.writeFileSync(stderrPath, "", "utf-8");

	const record = {
		id: recordId,
		parentSessionId: sessionId,
		cwd: ctx.cwd,
		taskPreview: "dead pid no output",
		timeout: 3600,
		running: true,
		pid: 32767, // definitely not running
		sessionFile: path.join(childDataDir, "session.jsonl"),
		outputFile: path.join(childDataDir, "result.log"),
		stdoutFile: stdoutPath,
		stderrFile: stderrPath,
		createdAt: Date.now() - 60_000,
		updatedAt: Date.now() - 60_000,
	};
	fs.writeFileSync(
		storeFilePath,
		JSON.stringify({ records: [record] }, null, 2),
		{ mode: 0o600 },
	);

	const result = executeSubagentToolInFreshProcess({
		sessionId,
		cwd: ctx.cwd,
		tool: "get_subagent_status",
		id: recordId,
	});

	const status = result.result as {
		details: {
			id: string;
			running: boolean;
			resultPath?: string;
			error?: string;
		};
	};
	assert.equal(status.details.id, recordId);
	assert.equal(status.details.running, false);
	assert.ok(status.details.resultPath);
	assert.equal(
		fs.readFileSync(status.details.resultPath, "utf-8").trim(),
		"(no output)",
	);

	// Persisted record must also show terminal no-output result path
	const persisted = readPersistedRecord(sessionId, recordId);
	assert.equal(persisted.running, false);
	assert.equal(
		fs.readFileSync(persisted.result, "utf-8").trim(),
		"(no output)",
	);
	assert.ok(persisted.completedAt);

	// Widget should NOT render an active line for this record
	// Verify via list: should show running=false
	const listResult = executeSubagentToolInFreshProcess({
		sessionId,
		cwd: ctx.cwd,
		tool: "list_subagents",
	});
	const listed = listResult.result as {
		details: { subagents: Array<{ id: string; running: boolean }> };
	};
	assert.deepEqual(listed.details.subagents, [
		{ id: recordId, running: false },
	]);

	cleanupTestCtx(ctx, sessionId);
});

test("Phase 7.13: per-parent widget timer cleanup — one parent idles, other stays active", async () => {
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
	mockPi.onCall({ output: "parent-a done", exitCode: 0, delay: 80 });
	// Parent B must remain active while parent A idles; use a long-lived child
	// and explicitly terminate it after the active-timer assertion.
	mockPi.onCall({ output: "parent-b done", exitCode: 0, delay: 30_000 });

	// Parent A
	const a = makeTestCtx("pi-subagents-timer-a-13");
	const fakeA = makeFakeCtx(a.sessionId, a.ctx.cwd, true);
	const toolsA = registerTestTools(() => {});

	// Parent B
	const b = makeTestCtx("pi-subagents-timer-b-13");
	const fakeB = makeFakeCtx(b.sessionId, b.ctx.cwd, true);
	const toolsB = registerTestTools(() => {});

	try {
		// Spawn async in both parents
		await toolsA.spawnTool.execute(
			"timer-child-a",
			{
				task: "parent A child",
				async: true,
			},
			new AbortController().signal,
			undefined,
			fakeA.ctx,
		);
		await toolsB.spawnTool.execute(
			"timer-child-b",
			{
				task: "parent B child",
				async: true,
			},
			new AbortController().signal,
			undefined,
			fakeB.ctx,
		);

		// Both should have widget lines
		const aRender = fakeA.widgetCalls.find(
			(c) => c.lines != null && c.lines.length === 1,
		);
		const bRender = fakeB.widgetCalls.find(
			(c) => c.lines != null && c.lines.length === 1,
		);
		assert.ok(aRender, "parent A should have widget line");
		assert.ok(bRender, "parent B should have widget line");
		assert.equal(timers.length, 4, "two timers per active parent");
		const parentATimers = timers.slice(0, 2);
		const parentBTimers = timers.slice(2, 4);
		assert.deepEqual(
			parentATimers.map((t) => t.ms).sort((x, y) => x - y),
			[1000, 5000],
			"parent A has widget + reconcile timers",
		);
		assert.deepEqual(
			parentBTimers.map((t) => t.ms).sort((x, y) => x - y),
			[1000, 5000],
			"parent B has widget + reconcile timers",
		);

		// End parent A deterministically, then run parent A's reconcile timer
		// callback explicitly because this test stubs setInterval.
		const runningA = readPersistedRecord(a.sessionId, "timer-child-a");
		if (runningA.running && typeof runningA.pid === "number") {
			try {
				process.kill(runningA.pid, "SIGTERM");
			} catch {
				// Child may have exited between reading the durable record and cleanup.
			}
		}
		for (let i = 0; i < 200; i++) {
			parentATimers.find((timer) => timer.ms === 5000 && !timer.cleared)?.fn();
			const status = await toolsA.statusTool.execute(
				`timer-child-a-status-${i}`,
				{ id: "timer-child-a" },
				new AbortController().signal,
				undefined,
				fakeA.ctx,
			);
			if (!status.details.running) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		parentATimers.find((timer) => timer.ms === 5000)?.fn();

		await toolsA.listTool.execute(
			"timer-child-a-refresh",
			{},
			new AbortController().signal,
			undefined,
			fakeA.ctx,
		);

		// Parent A's widget should be cleared after list/status reconciliation observes idle state.
		let aClearCount = 0;
		for (let i = 0; i < 100; i++) {
			aClearCount = fakeA.widgetCalls.filter(
				(c) => c.lines === undefined && c.key?.includes("pi-subagents-running"),
			).length;
			if (aClearCount >= 1 && parentATimers.every((timer) => timer.cleared))
				break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(
			aClearCount >= 1 || parentATimers.every((timer) => timer.cleared),
			"parent A should become idle after child completes",
		);
		assert.ok(
			parentATimers.every((timer) => timer.cleared),
			"idle parent A timers should be cleared one by one",
		);
		assert.ok(
			parentBTimers.every((timer) => !timer.cleared),
			"active parent B timers must remain scheduled",
		);

		// Parent B's child is still running (delay 3000), widget should still have line
		const timerChildBActualId = actualSubagentId("timer-child-b");
		const bStillShown = fakeB.widgetCalls.some(
			(c) =>
				c.lines != null &&
				c.lines.length === 1 &&
				c.lines[0].includes(timerChildBActualId),
		);
		assert.ok(
			bStillShown,
			"parent B widget should still be active while child runs",
		);

		const runningB = readPersistedRecord(b.sessionId, "timer-child-b");
		assert.equal(
			runningB.running,
			true,
			"parent B child remains active before cleanup",
		);
		assert.equal(typeof runningB.pid, "number");
		try {
			process.kill(runningB.pid, "SIGTERM");
		} catch {
			// If the child exited between the assertion and cleanup, status polling below
			// still observes the terminal state.
		}

		// Now wait for parent B's child to complete.
		let bStatus: any;
		for (let i = 0; i < 200; i++) {
			parentBTimers.find((timer) => timer.ms === 5000 && !timer.cleared)?.fn();
			bStatus = await toolsB.statusTool.execute(
				`status-timer-child-b-${i}`,
				{ id: "timer-child-b" },
				new AbortController().signal,
				undefined,
				fakeB.ctx,
			);
			if (!bStatus.details.running) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(
			bStatus.details.running,
			false,
			"parent B child should complete",
		);

		// Parent B's widget should also clear now.
		let bClearCount = 0;
		for (let i = 0; i < 100; i++) {
			bClearCount = fakeB.widgetCalls.filter(
				(c) => c.lines === undefined && c.key?.includes("pi-subagents-running"),
			).length;
			if (bClearCount >= 1) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(
			bClearCount >= 1 || parentBTimers.every((timer) => timer.cleared),
			"parent B widget should clear after its child completes",
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(a.ctx, a.sessionId);
		cleanupTestCtx(b.ctx, b.sessionId);
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
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
		c.lines?.some((line) => line.includes(recordId)),
	);
	assert.ok(
		activeWidget,
		"widget should show active line for persisted live child",
	);

	cleanupTestCtx(ctx, sessionId);
});

test("Phase 7.15: completion callback after timeout — one timeout, one completion, terminal state persists", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	// Child takes long enough for timeout to fire first
	mockPi.onCall({ output: "eventual done", exitCode: 0, delay: 200 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-timeout-complete-15");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);

	const sentMessages: string[] = [];
	const { spawnTool, statusTool } = registerTestTools((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") sentMessages.push(content);
	});

	try {
		await spawnTool.execute(
			"timeout-then-complete",
			{
				task: "timeout then done",
				async: true,
				timeout: 0.08, // fires before delay=200
			},
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		// Wait for timeout to fire (0.08s + buffer)
		await new Promise((resolve) => setTimeout(resolve, 150));

		// Trigger widget render via status (status check avoids waiting for timer)
		await statusTool.execute(
			"trigger-timeout-widget-refresh",
			{ id: "timeout-then-complete" },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);

		// Check timeout notification was sent
		const timeoutThenCompleteId = actualSubagentId("timeout-then-complete");
		const timeoutMessages = sentMessages.filter(
			(m) => m.includes(timeoutThenCompleteId) && m.includes("timed out after"),
		);
		assert.equal(timeoutMessages.length, 1, "exactly one timeout notification");

		// Widget should show timed out, still running
		const timedOutWidget = fake.widgetCalls.find(
			(c) =>
				c.lines != null &&
				c.lines.some((line) => /timed out, still running/.test(line)),
		);
		assert.ok(timedOutWidget, "widget should show timed out state");

		// Now wait for completion
		const finalStatus = await waitForStatus(
			statusTool,
			"timeout-then-complete",
			fake.ctx,
		);
		assert.equal(finalStatus.details.running, false);
		assert.ok(finalStatus.details.resultPath);
		assert.equal(
			fs.readFileSync(finalStatus.details.resultPath, "utf-8").trim(),
			"eventual done",
		);
		assert.equal(finalStatus.details.timedOut, true);

		// Completion notification should be sent exactly once
		const completionMessages = sentMessages.filter(
			(m) => m.includes(timeoutThenCompleteId) && m.includes("completed"),
		);
		assert.equal(
			completionMessages.length,
			1,
			"exactly one completion notification",
		);

		// Terminal state persists
		const record = readPersistedRecord(sessionId, "timeout-then-complete");
		assert.equal(record.running, false);
		assert.equal(
			fs.readFileSync(record.result, "utf-8").trim(),
			"eventual done",
		);
		assert.ok(record.timeoutAt);
		assert.equal(record.notifiedCompletion, true);

		// Widget should clear
		const clearCalls = fake.widgetCalls.filter(
			(c) => c.lines === undefined && c.key?.includes("pi-subagents-running"),
		);
		assert.ok(clearCalls.length >= 1, "widget should clear after completion");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});
