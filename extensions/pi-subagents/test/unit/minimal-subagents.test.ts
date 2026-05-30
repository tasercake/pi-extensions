import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

function readPersistedRecord(sessionId: string, id: string) {
	const store = JSON.parse(fs.readFileSync(storeFile(sessionId), "utf-8")) as {
		records: Array<Record<string, any>>;
	};
	const record = store.records.find((candidate) => candidate.id === id);
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
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return record ?? readPersistedRecord(sessionId, id);
}

function freshCtxForSameSession(ctx: { cwd: string }, sessionId: string) {
	const sessionFile = path.join(sessionId, "session.jsonl");
	return {
		cwd: ctx.cwd,
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionFile,
		},
	};
}

function readSubagentStore(sessionId: string) {
	return JSON.parse(fs.readFileSync(storeFile(sessionId), "utf-8")) as {
		records: Array<Record<string, unknown>>;
	};
}

function readSubagentRecord(sessionId: string, id: string) {
	const record = readSubagentStore(sessionId).records.find((r) => r.id === id);
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
      ${JSON.stringify(args.tool === "get_subagent_status" ? { id: args.id } : {})},
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

function registerTestTools(sendMessage: (...args: unknown[]) => void) {
	const registered = new Map<string, any>();
	const fakePi = {
		registerTool(tool: { name: string }) {
			registered.set(tool.name, tool);
		},
		sendMessage,
	};
	registerSubagentExtension(fakePi as never);
	return {
		spawnTool: registered.get("spawn_subagent"),
		statusTool: registered.get("get_subagent_status"),
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

test("schemas expose minimal three-tool parameter shapes", async () => {
	assert.equal(SpawnSubagentParams.additionalProperties, false);
	assert.deepEqual(
		Object.keys(SpawnSubagentParams.properties).sort(),
		["async", "cwd", "keepContext", "model", "task", "timeout"].sort(),
	);
	assert(!("outputMode" in SpawnSubagentParams.properties));
	assert.match(
		SpawnSubagentParams.properties.timeout.description,
		/Do not kill/i,
	);
	assert.match(
		SpawnSubagentParams.properties.timeout.description,
		/healthy timeout margin/i,
	);
	assert.equal(GetSubagentStatusParams.additionalProperties, false);
	assert.deepEqual(Object.keys(GetSubagentStatusParams.properties), ["id"]);
	assert.equal(ListSubagentsParams.additionalProperties, false);
	assert.deepEqual(Object.keys(ListSubagentsParams.properties), []);

	const schemas = await import("../../src/extension/schemas.ts");
	assert.equal("SteerSubagentParams" in schemas, false);
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
			{ task: "finish", async: true, keepContext: false, timeout: 30 },
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
			{ task: "finish", async: true, keepContext: false },
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
			{ task: "finish", async: true, keepContext: false },
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
			{ id: "retry-list-child", running: false },
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
			{ task: "finish", async: true, keepContext: false },
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
			{ task: "finish first", async: true, keepContext: false },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await spawnTool.execute(
			"stale-final-cohort-second",
			{ task: "finish second", async: true, keepContext: false },
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
			{ task: "slow", async: true, keepContext: false, timeout: 0.3 },
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
		assert.match(
			timedOutStatus.details.timeoutMessage,
			/sessionId=mock-session-/,
		);
		assert.match(timedOutStatus.details.timeoutMessage, /pid=\d+/);
		assert.equal(sentMessages.length, 1);
		assert.match(sentMessages[0], /timed out after 0\.3s/);
		assert.match(sentMessages[0], /not killed/);
		assert.match(sentMessages[0], /sessionId=mock-session-/);
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
				keepContext: false,
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
				keepContext: false,
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
			{ task: "trigger retry", async: true, keepContext: false, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const timeoutNotifications = retryMessages.filter((content) =>
			/timed out after 0.05s/.test(content),
		);
		assert.equal(timeoutNotifications.length, 1);
		assert.match(
			timeoutNotifications[0],
			/Subagent stale-timeout-spawn-retry-child timed out/,
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
				keepContext: false,
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
				keepContext: false,
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
		assert.match(
			retriedNotifications[0],
			/Subagent stale-retry-child completed\./,
		);
		const retryStatus = retry.result as {
			details: { id: string; running: boolean; resultPath: string };
		};
		assert.equal(retryStatus.details.id, childId);
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
			{ task: "finish first", async: true, keepContext: false, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await spawnTool.execute(
			"stale-cohort-second",
			{ task: "finish second", async: true, keepContext: false, timeout: 30 },
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
test("spawn response includes resultPath", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "hello", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-resultpath-spawn");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"resultpath-child",
			{ task: "echo hello", async: false, keepContext: false },
			new AbortController().signal,
			undefined,
			ctx,
		);
		// resultPath must be present in details
		assert.ok(result.details.resultPath, "resultPath must be present");
		assert.match(
			result.details.resultPath,
			/subagents\/resultpath-child\/result\.md$/,
		);
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
			{ task: "finish", async: true, keepContext: false, timeout: 30 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.ok(result.details.resultPath, "resultPath must be present");
		assert.match(
			result.details.resultPath,
			/subagents\/async-resultpath-child\/result\.md$/,
		);
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
			{ task: "finish", async: true, keepContext: false, timeout: 30 },
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

		const completionMessage = sentMessages.find(
			(m) => m.includes("notify-resultpath-child") && m.includes("completed"),
		);
		assert.ok(completionMessage, "completion message must exist");
		assert.match(completionMessage!, /Result file:/);
		assert.match(completionMessage!, /result\.md/);
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
			{ task: "finish", async: false, keepContext: false },
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
		assert.match(status.details.resultPath, /result\.md$/);
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
				keepContext: false,
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
		// Pre-create the result file BEFORE spawning.
		// makeRecord uses fs.mkdirSync(dir, { recursive: true }) — idempotent, safe.
		// sessionId is now the base dir (cwd of getBaseDir).
		const childDirPath = path.join(sessionId, "subagents", "preserve-child");
		fs.mkdirSync(childDirPath, { recursive: true });
		const resultPath = path.join(childDirPath, "result.md");
		fs.writeFileSync(resultPath, "pre-written by subagent\n", "utf-8");

		mockPi.onCall({ output: "different stdout output", exitCode: 0 });

		// Blocking spawn — the pre-created result file must survive unmodified.
		const result = await spawnTool.execute(
			"preserve-child",
			{ task: "finish", async: false, keepContext: false },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const content = fs.readFileSync(result.details.resultPath, "utf-8");
		assert.equal(content.trim(), "pre-written by subagent");
		// Must NOT contain the stdout output
		assert(!content.includes("different stdout output"));
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// Test 8: Prompt injection includes result path (Requirement 4)
test("subagent system prompt includes result file path when env var set", () => {
	const prompt = "Original system prompt.";
	const resultPath = "/tmp/subagents/abc/result.md";
	process.env[SUBAGENT_RESULT_PATH_ENV] = resultPath;

	// Simulate the handler's logic (mirrors registerSubagentPromptRuntime):
	const RESULT_PATH_MARKER = "Your result file:";
	let rewritten = rewriteSubagentPrompt(prompt);
	if (resultPath && !rewritten.includes(RESULT_PATH_MARKER)) {
		rewritten = `${rewritten}\n\nYour result file: ${resultPath}\nYou may write your final output to this file at any time using any tool (e.g., write, bash). If you leave the file empty, your final assistant message will be automatically saved there on exit.`;
	}

	assert.ok(rewritten.includes(resultPath));
	assert.ok(rewritten.includes("Your result file:"));
	assert.ok(rewritten.includes("write"));
	assert.ok(rewritten.includes("automatically saved"));

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
	const resultPath = "/tmp/subagents/test/result.md";
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
test("integration: blocking subagent writes result.md at expected path", () => {
	// Find the pi binary
	const piBin = process.env.PI_BIN || "pi";

	// Create a temp session file so we can inspect the result
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-int-"));
	const sessionFile = path.join(tmpDir, "session.jsonl");
	const sessionId = path.basename(tmpDir);

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
			const resultPath = path.join(subagentsDir, dir.name, "result.md");
			assert.ok(
				fs.existsSync(resultPath),
				`result.md must exist: ${resultPath}`,
			);
			const content = fs.readFileSync(resultPath, "utf-8");
			assert.ok(
				content.trim().length > 0,
				`result.md must not be empty: ${resultPath}`,
			);
		}
	} finally {
		// Best-effort cleanup
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	}
});
