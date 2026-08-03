import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SpawnSubagentParams } from "../../src/extension/schemas.ts";
import { createMockPi } from "../support/mock-pi.ts";
import registerSubagentPromptRuntime, {
	CHILD_SUBAGENT_SYSTEM_LINE,
	rewriteSubagentPrompt,
	SUBAGENT_RESULT_PATH_ENV,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { CappedLogWriter } from "../../src/runs/shared/capped-log.ts";
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
		tools: registered,
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

test("spawn schema accepts task only and rejects removed properties", () => {
	assert.equal(Value.Check(SpawnSubagentParams, { task: "x" }), true);
	assert.equal(
		Value.Check(SpawnSubagentParams, { task: "x", ["async"]: true }),
		false,
	);
	assert.equal(
		Value.Check(SpawnSubagentParams, { task: "x", ["async"]: false }),
		false,
	);
	assert.equal(
		Value.Check(SpawnSubagentParams, {
			task: "x",
			keepContext: false,
		}),
		false,
	);
});

test("extension registers read-only subagent inspection tools with bounded tail schema", () => {
	const { tools } = registerTestTools();

	assert.deepEqual([...tools.keys()], [
		"spawn_subagent",
		"list_subagents",
		"get_subagent_status",
		"tail_subagent",
	]);
	assert.equal(Value.Check(tools.get("list_subagents").parameters, {}), true);
	assert.equal(
		Value.Check(tools.get("get_subagent_status").parameters, { id: "child-1" }),
		true,
	);

	const tailSchema = tools.get("tail_subagent").parameters;
	assert.equal(Value.Check(tailSchema, { id: "child-1" }), true);
	assert.equal(Value.Check(tailSchema, { id: "child-1", lines: 1 }), true);
	assert.equal(Value.Check(tailSchema, { id: "child-1", lines: 200 }), true);
	assert.equal(Value.Check(tailSchema, { id: "child-1", lines: 0 }), false);
	assert.equal(Value.Check(tailSchema, { id: "child-1", lines: 201 }), false);
	assert.equal(Value.Check(tailSchema, { id: "child-1", lines: 1.5 }), false);
	assert.equal(Value.Check(tailSchema, { id: "child-1", extra: true }), false);
	assert.equal(tailSchema.properties.lines.default, 20);
});

test("list and status tools inspect records persisted for current parent", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-inspection");
	const childDir = path.join(sessionId, "subagents", "child-1");
	const outputFile = path.join(childDir, "result.log");
	const stdoutFile = path.join(childDir, "stdout.log");
	const stderrFile = path.join(childDir, "stderr.log");
	fs.mkdirSync(childDir, { recursive: true });
	fs.writeFileSync(outputFile, "done\n");
	fs.writeFileSync(stdoutFile, "{\"type\":\"done\"}\n");
	fs.writeFileSync(stderrFile, "");
	fs.writeFileSync(
		storeFile(sessionId),
		JSON.stringify({
			records: [{
				id: "child-1",
				parentSessionId: sessionId,
				cwd: ctx.cwd,
				taskPreview: "inspect me",
				model: "mock/model",
				running: false,
				outputFile,
				stdoutFile,
				stderrFile,
				createdAt: 10,
				updatedAt: 20,
				completedAt: 20,
			}],
		}, null, 2),
	);

	try {
		const { tools } = registerTestTools();
		const signal = new AbortController().signal;
		const listed = await tools.get("list_subagents").execute(
			"list-call", {}, signal, undefined, ctx,
		);
		assert.deepEqual(listed.details.subagents, [{
			id: "child-1",
			running: false,
		}]);

		const status = await tools.get("get_subagent_status").execute(
			"status-call", { id: "child-1" }, signal, undefined, ctx,
		);
		assert.deepEqual(status.details, {
			id: "child-1",
			sessionId: "child-1",
			running: false,
			resultPath: outputFile,
		});
		assert.deepEqual(JSON.parse(status.content[0].text), status.details);
	} finally {
		cleanupTestCtx(ctx, sessionId);
	}
});

test("tail_subagent returns recent complete NDJSON lines and drops a trailing partial line", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-tail");
	const childDir = path.join(sessionId, "subagents", "child-tail");
	const stdoutFile = path.join(childDir, "stdout.log");
	fs.mkdirSync(childDir, { recursive: true });
	const completeLines = Array.from(
		{ length: 25 },
		(_, index) => JSON.stringify({ type: "event", index }),
	);
	fs.writeFileSync(stdoutFile, `${completeLines.join("\n")}\n{\"partial\":`);
	fs.writeFileSync(
		storeFile(sessionId),
		JSON.stringify({
			records: [{
				id: "child-tail",
				parentSessionId: sessionId,
				cwd: ctx.cwd,
				taskPreview: "tail me",
				running: true,
				pid: process.pid,
				outputFile: path.join(childDir, "result.log"),
				stdoutFile,
				stderrFile: path.join(childDir, "stderr.log"),
				createdAt: 10,
				updatedAt: 20,
			}],
		}, null, 2),
	);

	try {
		const { tools } = registerTestTools();
		const result = await tools.get("tail_subagent").execute(
			"tail-call",
			{ id: "child-tail" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(result.details.id, "child-tail");
		assert.equal(result.details.running, true);
		assert.deepEqual(result.details.lines, completeLines.slice(-20));
		assert.equal(result.content[0].text, completeLines.slice(-20).join("\n"));
		assert.doesNotMatch(result.content[0].text, /partial/);
	} finally {
		cleanupTestCtx(ctx, sessionId);
	}
});

test("inspection tools reject ids outside current parent store", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-unknown-inspection");
	try {
		const { tools } = registerTestTools();
		const signal = new AbortController().signal;
		await assert.rejects(
			() => tools.get("get_subagent_status").execute(
				"status-call", { id: "missing" }, signal, undefined, ctx,
			),
			/Unknown subagent id: missing/,
		);
		await assert.rejects(
			() => tools.get("tail_subagent").execute(
				"tail-call", { id: "missing" }, signal, undefined, ctx,
			),
			/Unknown subagent id: missing/,
		);
	} finally {
		cleanupTestCtx(ctx, sessionId);
	}
});

test("model override contract is synchronized across schema, tool, README, and skill", () => {
	const schemaDescription =
		(SpawnSubagentParams.properties.model as { description?: string }).description ?? "";
	const extensionSource = fs.readFileSync(
		path.join(projectRoot, "src", "extension", "index.ts"),
		"utf-8",
	);
	const readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf-8");
	const skill = fs.readFileSync(
		path.join(projectRoot, "skills", "pi-subagents", "SKILL.md"),
		"utf-8",
	);

	for (const [surface, text] of [
		["schema", schemaDescription],
		["tool", extensionSource],
		["README", readme],
		["skill", skill],
	] as const) {
		assert.match(text, /(?:explicit model override|model[^\n]*explicit override)/i, `${surface} must call model an explicit override`);
		assert.match(text, /omit(?:ted|ting)[^\n]*inherit[^\n]*parent[^\n]*provider\/model/i, `${surface} must document canonical parent model inheritance`);
	}
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
		`async: ${"true"}`,
		`async: ${"false"}`,
		"outputmode",
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

function runPromptRuntimeTerminalMessage(
	stopReason: "stop" | "error" | "aborted",
	errorMessage?: string,
	options: { content?: unknown[]; resultPath?: string } = {},
) {
	const runtimePath = path.join(
		projectRoot,
		"src",
		"runs",
		"shared",
		"subagent-prompt-runtime.ts",
	);
	const script = `
		import registerRuntime from ${JSON.stringify(runtimePath)};
		let messageEnd;
		let agentSettled;
		let sessionShutdown;
		registerRuntime({
			on(event, handler) {
				if (event === "message_end") messageEnd = handler;
				if (event === "agent_settled") agentSettled = handler;
				if (event === "session_shutdown") sessionShutdown = handler;
			},
		});
		if (!messageEnd) throw new Error("message_end handler was not registered");
		if (!agentSettled) throw new Error("agent_settled handler was not registered");
		if (!sessionShutdown) throw new Error("session_shutdown handler was not registered");
		await messageEnd({
			type: "message_end",
			message: {
				role: "assistant",
				content: ${JSON.stringify(options.content ?? [])},
				provider: "test-provider",
				model: "test-model",
				stopReason: ${JSON.stringify(stopReason)},
				errorMessage: ${JSON.stringify(errorMessage)},
			},
		});
		await agentSettled({ type: "agent_settled" });
		if (${JSON.stringify(stopReason)} === "error") {
			setInterval(() => {}, 60_000);
		} else {
			await sessionShutdown({ type: "session_shutdown", reason: "quit" });
			setTimeout(() => process.exit(0), 30);
		}
	`;
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", script],
		{
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: 1500,
			env: {
				...process.env,
				PI_NO_COLOR: "1",
				...(options.resultPath
					? { PI_SUBAGENT_RESULT_PATH: options.resultPath }
					: {}),
			},
		},
	);
}

test("prompt runtime exits nonzero promptly on canonical assistant provider failure", () => {
	const startedAt = Date.now();
	const result = runPromptRuntimeTerminalMessage(
		"error",
		"HTTP 402: provider credits exhausted",
	);

	assert.equal(result.status, 1, result.stderr || result.stdout);
	assert.ok(Date.now() - startedAt < 1000, "provider failure must not wait on the child lifeline");
	assert.match(result.stderr, /HTTP 402: provider credits exhausted/);
});

test("prompt runtime does not misclassify abort as provider failure", () => {
	const result = runPromptRuntimeTerminalMessage("aborted", "Request was aborted");
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.doesNotMatch(result.stderr, /Request was aborted/);
});

test("prompt runtime leaves successful terminal messages successful", () => {
	const result = runPromptRuntimeTerminalMessage("stop");
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(result.stderr, "");
});

test("prompt runtime atomically saves the final assistant text on shutdown", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runtime-result-"));
	const resultPath = path.join(dir, "result.log");
	try {
		const result = runPromptRuntimeTerminalMessage("stop", undefined, {
			content: [{ type: "text", text: "durable child result" }],
			resultPath,
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(fs.readFileSync(resultPath, "utf-8"), "durable child result\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("prompt runtime preserves an explicitly written result", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runtime-preserve-"));
	const resultPath = path.join(dir, "result.log");
	fs.writeFileSync(resultPath, "explicit result\n", { mode: 0o600 });
	try {
		const result = runPromptRuntimeTerminalMessage("stop", undefined, {
			content: [{ type: "text", text: "fallback result" }],
			resultPath,
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(fs.readFileSync(resultPath, "utf-8"), "explicit result\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("prompt runtime persists an error result before provider-failure exit", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runtime-error-"));
	const resultPath = path.join(dir, "result.log");
	try {
		const result = runPromptRuntimeTerminalMessage(
			"error",
			"HTTP 402: provider credits exhausted",
			{ resultPath },
		);
		assert.equal(result.status, 1, result.stderr || result.stdout);
		assert.equal(fs.readFileSync(resultPath, "utf-8"), "(error)\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
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

function registerPromptRuntimeHandlers() {
	const handlers = new Map<string, (event: any) => unknown>();
	registerSubagentPromptRuntime({
		on(event: string, handler: (event: any) => unknown) {
			handlers.set(event, handler);
		},
	} as never);
	return handlers;
}

async function withResultPath(
	resultPath: string | undefined,
	callback: () => Promise<void>,
) {
	const previousResultPath = process.env[SUBAGENT_RESULT_PATH_ENV];
	if (resultPath === undefined) delete process.env[SUBAGENT_RESULT_PATH_ENV];
	else process.env[SUBAGENT_RESULT_PATH_ENV] = resultPath;
	try {
		await callback();
	} finally {
		if (previousResultPath === undefined) {
			delete process.env[SUBAGENT_RESULT_PATH_ENV];
		} else {
			process.env[SUBAGENT_RESULT_PATH_ENV] = previousResultPath;
		}
	}
}

test("prompt runtime rewrites a literal result-path alias for file tools", async () => {
	const toolCall = registerPromptRuntimeHandlers().get("tool_call");
	assert.ok(toolCall, "prompt runtime must register a tool_call guard");

	await withResultPath("/tmp/subagents/abc/result.log", async () => {
		const event = {
			toolName: "write",
			input: { path: "$PI_SUBAGENT_RESULT_PATH", content: "done" },
		};
		await toolCall(event);
		assert.equal(event.input.path, "/tmp/subagents/abc/result.log");
	});
});

test("prompt runtime rewrites both exact aliases for write edit and read", async () => {
	const toolCall = registerPromptRuntimeHandlers().get("tool_call");
	assert.ok(toolCall);

	await withResultPath("/tmp/subagents/abc/result.log", async () => {
		for (const [toolName, alias] of [
			["write", "${PI_SUBAGENT_RESULT_PATH}"],
			["edit", "$PI_SUBAGENT_RESULT_PATH"],
			["read", "${PI_SUBAGENT_RESULT_PATH}"],
		] as const) {
			const event = { toolName, input: { path: alias } };
			await toolCall(event);
			assert.equal(event.input.path, "/tmp/subagents/abc/result.log");
		}
	});
});

test("prompt runtime leaves non-exact paths and unrelated variables unchanged", async () => {
	const toolCall = registerPromptRuntimeHandlers().get("tool_call");
	assert.ok(toolCall);

	await withResultPath("/tmp/subagents/abc/result.log", async () => {
		for (const candidate of [
			"prefix/$PI_SUBAGENT_RESULT_PATH",
			"${PI_SUBAGENT_RESULT_PATH}/suffix",
			"$HOME/result.log",
			"/tmp/ordinary.log",
		]) {
			const event = { toolName: "write", input: { path: candidate } };
			await toolCall(event);
			assert.equal(event.input.path, candidate);
		}
	});
});

test("prompt runtime leaves aliases unchanged when result env is missing", async () => {
	const toolCall = registerPromptRuntimeHandlers().get("tool_call");
	assert.ok(toolCall);

	await withResultPath(undefined, async () => {
		const event = {
			toolName: "read",
			input: { path: "$PI_SUBAGENT_RESULT_PATH" },
		};
		await toolCall(event);
		assert.equal(event.input.path, "$PI_SUBAGENT_RESULT_PATH");
	});
});

test("prompt runtime never rewrites bash commands", async () => {
	const toolCall = registerPromptRuntimeHandlers().get("tool_call");
	assert.ok(toolCall);

	await withResultPath("/tmp/subagents/abc/result.log", async () => {
		const event = {
			toolName: "bash",
			input: {
				path: "$PI_SUBAGENT_RESULT_PATH",
				command: 'printf done > "$PI_SUBAGENT_RESULT_PATH"',
			},
		};
		await toolCall(event);
		assert.equal(event.input.path, "$PI_SUBAGENT_RESULT_PATH");
		assert.equal(
			event.input.command,
			'printf done > "$PI_SUBAGENT_RESULT_PATH"',
		);
	});
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
	assert(built.args.includes("--print"));
	assert.equal(built.args.includes("--mode"), false);
});

test("capped log writer consumes excess output without exceeding its byte cap", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-capped-log-"));
	const logPath = path.join(dir, "stdout.log");
	try {
		const writer = new CappedLogWriter(logPath, 64);
		await new Promise<void>((resolve, reject) => {
			writer.once("error", reject);
			writer.end(Buffer.alloc(256, 0x61), resolve);
		});
		const content = fs.readFileSync(logPath);
		assert.equal(content.length, 64);
		assert.match(content.toString("utf8"), /pi-subagents log truncated/);

		const appended = new CappedLogWriter(logPath, 64);
		await new Promise<void>((resolve, reject) => {
			appended.once("error", reject);
			appended.end("more data", resolve);
		});
		assert.equal(fs.statSync(logPath).size, 64);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
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
			{ task: "finish" },
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

test("omitted model inherits and reports the active parent canonical provider/model", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "inherited model done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-model-inherit");
	const parentModel = { provider: "openai-codex", id: "gpt-5.3-codex" };
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"model-inherit-child",
			{ task: "inherit parent model" },
			new AbortController().signal,
			undefined,
			{ ...ctx, model: parentModel },
		);
		const record = await waitForPersistedRecord(sessionId, result.details.id);
		const args = readLatestMockPiArgs(mockPi).args;
		const modelFlag = args.indexOf("--model");

		assert.notEqual(modelFlag, -1, "child args must always select the effective model");
		assert.equal(args[modelFlag + 1], "openai-codex/gpt-5.3-codex");
		assert.equal(record.model, "openai-codex/gpt-5.3-codex");
		assert.equal(result.details.model, "openai-codex/gpt-5.3-codex");
		assert.match(result.content[0].text, /openai-codex\/gpt-5\.3-codex/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("explicit model override wins over the active parent model", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "override model done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-model-override");
	const { spawnTool } = registerTestTools(() => {});
	const override = "anthropic/claude-opus-4-6";

	try {
		const result = await spawnTool.execute(
			"model-override-child",
			{ task: "override parent model", model: override },
			new AbortController().signal,
			undefined,
			{ ...ctx, model: { provider: "openai", id: "gpt-5.4" } },
		);
		const record = await waitForPersistedRecord(sessionId, result.details.id);
		const args = readLatestMockPiArgs(mockPi).args;
		const modelFlag = args.indexOf("--model");

		assert.equal(args[modelFlag + 1], override);
		assert.equal(record.model, override);
		assert.equal(result.details.model, override);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("provider failure finalizes once with error text and result fallback", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({
		jsonl: [{
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				provider: "test-provider",
				model: "test-model",
				stopReason: "error",
				errorMessage: "HTTP 402: provider credits exhausted",
			},
		}],
		stderr: "HTTP 402: provider credits exhausted\n",
		exitCode: 1,
	});

	const { sessionId, ctx } = makeTestCtx("pi-subagents-provider-failure");
	const notifications: string[] = [];
	const { spawnTool } = registerTestTools((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") notifications.push(content);
	});

	try {
		const result = await spawnTool.execute(
			"provider-failure-child",
			{ task: "trigger provider failure" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const record = await waitForPersistedRecord(sessionId, result.details.id);

		assert.equal(record.running, false);
		assert.equal(typeof record.completedAt, "number");
		assert.match(record.error, /HTTP 402: provider credits exhausted/);
		assert.equal(fs.readFileSync(record.outputFile, "utf-8"), "(error)\n");
		assert.equal(notifications.length, 1, "failure must emit one completion notification");
		assert.equal(record.notifiedCompletion, true);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("spawn persists unified id session file result.log and fresh args", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "uuid done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-unified-id");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"unified-id-call",
			{ task: "echo uuid" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const record = await waitForPersistedRecord(sessionId, result.details.id);
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
			{ task: "fresh only" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const record = await waitForPersistedRecord(sessionId, result.details.id);
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
			{ task: "echo hello" },
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
		await waitForPersistedRecord(sessionId, result.details.id);
		// result file must exist and contain output
		const content = fs.readFileSync(result.details.resultPath, "utf-8");
		assert.match(content, /hello/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// Test 3: Async spawn response includes resultPath (Requirement 2)
test("spawn returns before child completes and persists final result later", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "delayed done", exitCode: 0, delay: 120 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-immediate-return");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const startedAt = Date.now();
		const result = await spawnTool.execute(
			"immediate-child",
			{ task: "delayed work" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.ok(Date.now() - startedAt < 100, "execute must return before child completes");
		assert.match(result.content[0].text, /Spawned subagent/);
		assert.match(result.content[0].text, /notified/);
		assert.ok(result.details.resultPath);
		const running = readPersistedRecord(sessionId, result.details.id);
		assert.equal(running.running, true);

		const completed = await waitForPersistedRecord(sessionId, result.details.id);
		assert.equal(completed.running, false);
		assert.match(fs.readFileSync(result.details.resultPath, "utf-8"), /delayed done/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

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
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		await waitForPersistedRecord(sessionId, result.details.id);
		const content = fs.readFileSync(result.details.resultPath, "utf-8");
		assert.match(content, /auto-saved output/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("auto-saves a print-mode answer that is valid JSON", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: '{"ok":true}', exitCode: 0 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-autosave-json-text");
	const { spawnTool } = registerTestTools(() => {});
	try {
		const result = await spawnTool.execute(
			"autosave-json-child",
			{ task: "return JSON" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await waitForPersistedRecord(sessionId, result.details.id);
		assert.equal(
			fs.readFileSync(result.details.resultPath, "utf-8"),
			'{"ok":true}\n',
		);
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
			{ task: "finish" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const record = await waitForPersistedRecord(sessionId, "preserve-child");
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
test("prompt runtime explains literal file paths shell aliases and fallback", async () => {
	const beforeAgentStart =
		registerPromptRuntimeHandlers().get("before_agent_start");
	assert.ok(beforeAgentStart);

	await withResultPath("/tmp/subagents/abc/result.log", async () => {
		const first = (await beforeAgentStart({
			systemPrompt: "Original system prompt.",
		})) as { systemPrompt: string };
		const rewritten = first.systemPrompt;

		assert.ok(
			rewritten.includes(
				"Your result file: /tmp/subagents/abc/result.log",
			),
		);
		assert.match(rewritten, /resolved absolute (result )?path/i);
		assert.match(rewritten, /file tools.*write.*edit.*read/i);
		assert.match(rewritten, /literal absolute path/i);
		assert.match(rewritten, /do not expand (shell )?environment variables/i);
		assert.match(rewritten, /PI_SUBAGENT_RESULT_PATH.*same path/i);
		assert.match(rewritten, /only inside (bash|shell)/i);
		assert.match(rewritten, /automatically saved there on exit/i);
		assert.doesNotMatch(rewritten, /using any tool/i);
		assert.doesNotMatch(
			rewritten,
			/write directly to ["']?\$PI_SUBAGENT_RESULT_PATH/i,
		);

		const second = (await beforeAgentStart({
			systemPrompt: rewritten,
		})) as { systemPrompt?: string } | undefined;
		assert.equal(second, undefined, "prompt injection must be idempotent");
	});
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

// Test 10: Integration — end-to-end background subagent with real pi binary (Scope Test Plan)
test("integration: background subagent writes result.log at expected path", (t) => {
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
		// Run pi with a prompt that spawns a background subagent.
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
				"Spawn a background subagent to echo hello world. Use spawn_subagent. It returns resultPath immediately; wait for notification, then read that file.",
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

test("N1: background subagent widget appears during execution and clears after", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "background widget done", exitCode: 0, delay: 80 });
	const { sessionId, ctx } = makeTestCtx("pi-subagents-sync-widget-n1");
	const fake = makeFakeCtx(sessionId, ctx.cwd, true);
	const { spawnTool } = registerTestTools(() => {});
	try {
		const resultPromise = spawnTool.execute(
			"sync-widget-child",
			{ task: "background widget" },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		for (let i = 0; i < 50; i++) {
			if (
				fake.widgetCalls.some((c) =>
					c.lines?.some((line) => line.includes("background widget")),
				)
			) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(
			fake.widgetCalls.some((c) =>
				c.lines?.some((line) => line.includes("background widget")),
			),
			"widget must render during child execution",
		);
		const result = await resultPromise;
		assert.equal(result.details.running, true);
		assert.ok(result.details.resultPath);
		const completed = await waitForPersistedRecord(sessionId, result.details.id);
		assert.equal(completed.running, false);
		assert.equal(
			fs.readFileSync(result.details.resultPath, "utf-8").trim(),
			"background widget done",
		);
		assert.ok(
			fake.widgetCalls.some((c) =>
				c.lines?.some((line) => line.includes("background widget")),
			),
			"widget rendered during background run",
		);
		assert.ok(
			fake.widgetCalls.some((c) => c.lines === undefined),
			"widget cleared after background run",
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
			{ task: "first line\nsecond line with more text" },
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
				{ task: "agent end" },
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
			{ task: "pending notice" },
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
			{ task: "headless liveness test" },
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
			/stdio:\s*\["ignore", "pipe", "pipe", "pipe"\]/,
			"extension child spawn uses a dedicated fd 3 lifeline without changing stdin",
		);
		assert.match(
			extensionSource,
			/env\[PI_SUBAGENT_LIFELINE_FD\]\s*=\s*"3"/,
			"child runtime receives the dedicated lifeline fd number",
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
		for (const id of ids) await spawnTool.execute(id, { task: id }, new AbortController().signal, undefined, fake.ctx);
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
		for (const id of ids) await spawnTool.execute(id, { task: id }, new AbortController().signal, undefined, fake.ctx);
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
		for (const id of ids) await spawnTool.execute(id, { task: id }, new AbortController().signal, undefined, fake.ctx);
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
		await spawnTool.execute("widget-fast", { task: "fast task" }, new AbortController().signal, undefined, fake.ctx);
		await spawnTool.execute("widget-slow", { task: "slow task" }, new AbortController().signal, undefined, fake.ctx);
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

test("cohort: turn_end does not close active cohort", async () => {
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
		await spawnTool.execute("turn-a", { task: "a" }, new AbortController().signal, undefined, fake.ctx);
		await spawnTool.execute("turn-b", { task: "b" }, new AbortController().signal, undefined, fake.ctx);
		assert.equal(handlers.has("turn_end"), false, "turn_end handler not registered for cohort reset");
		await spawnTool.execute("turn-c", { task: "c" }, new AbortController().signal, undefined, fake.ctx);
		await Promise.all(["turn-a", "turn-b", "turn-c"].map((id) => waitForPersistedRecord(sessionId, id)));
		const a = readPersistedRecord(sessionId, "turn-a");
		const b = readPersistedRecord(sessionId, "turn-b");
		const c = readPersistedRecord(sessionId, "turn-c");
		assert.equal(a.cohortId, b.cohortId);
		assert.equal(a.cohortId, c.cohortId);
		assert.equal(messages.some((m) => m.includes("out of 2") || m.includes("All 2")), false);
		assert.equal(messages.some((m) => m.includes(`Subagent ${c.id} completed.`) && !m.includes("out of")), false);
		assert.ok(messages.some((m) => m.includes("All 3 subagents completed successfully.")));
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
		return { id, parentSessionId: sessionId, cwd: ctx.cwd, taskPreview: id, running: false, outputFile, stdoutFile: path.join(child, "stdout.log"), stderrFile: path.join(child, "stderr.log"), createdAt: now + index, updatedAt: now + index, completedAt: now + index, pendingCompletionNotice: id === "legacy-a" };
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
		await spawnTool.execute("agent-a", { task: "a" }, new AbortController().signal, undefined, fake.ctx);
		await handlers.get("agent_end")(undefined, fake.ctx);
		await spawnTool.execute("agent-b", { task: "b" }, new AbortController().signal, undefined, fake.ctx);
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
	const record = { id: "reconcile-a", parentSessionId: sessionId, cwd: ctx.cwd, taskPreview: "x", running: true, outputFile: path.join(dir, "result.log"), stdoutFile: path.join(dir, "stdout.log"), stderrFile: path.join(dir, "stderr.log"), createdAt: Date.now(), updatedAt: Date.now(), cohortId: "cohort-keep", cohortCreatedAt: 12345 };
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

test("reconcile never reads an oversized legacy stdout log into a string", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-oversized-stdout");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const dir = path.join(sessionId, "subagents", "oversized-a");
	fs.mkdirSync(dir, { recursive: true });
	const record = { id: "oversized-a", parentSessionId: sessionId, cwd: ctx.cwd, taskPreview: "x", running: true, outputFile: path.join(dir, "result.log"), stdoutFile: path.join(dir, "stdout.log"), stderrFile: path.join(dir, "stderr.log"), createdAt: Date.now(), updatedAt: Date.now() };
	fs.writeFileSync(record.stdoutFile, "");
	fs.truncateSync(record.stdoutFile, 16 * 1024 * 1024 + 1);
	fs.writeFileSync(record.stderrFile, "");
	fs.writeFileSync(storeFile(sessionId), JSON.stringify({ records: [record] }, null, 2));
	const { handlers } = registerTestTools(() => {});
	try {
		await handlers.get("session_start")(undefined, fake.ctx);
		const persisted = readPersistedRecord(sessionId, "oversized-a");
		assert.equal(persisted.running, false);
		assert.equal(persisted.error, undefined);
		assert.equal(fs.readFileSync(record.outputFile, "utf-8"), "(no output)\n");
		assert.equal(fs.statSync(record.stdoutFile).size, 16 * 1024 * 1024 + 1);
	} finally {
		cleanupTestCtx(ctx, sessionId);
	}
});

test("reconcile compacts oversized legacy stdout after preserving an existing result", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-compact-stdout");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const dir = path.join(sessionId, "subagents", "compact-a");
	fs.mkdirSync(dir, { recursive: true });
	const record = { id: "compact-a", parentSessionId: sessionId, cwd: ctx.cwd, taskPreview: "x", running: true, outputFile: path.join(dir, "result.log"), stdoutFile: path.join(dir, "stdout.log"), stderrFile: path.join(dir, "stderr.log"), createdAt: Date.now(), updatedAt: Date.now() };
	fs.writeFileSync(record.outputFile, "preserved result\n");
	fs.writeFileSync(record.stdoutFile, "");
	fs.truncateSync(record.stdoutFile, 16 * 1024 * 1024 + 1);
	fs.writeFileSync(record.stderrFile, "");
	fs.writeFileSync(storeFile(sessionId), JSON.stringify({ records: [record] }, null, 2));
	const { handlers } = registerTestTools(() => {});
	try {
		await handlers.get("session_start")(undefined, fake.ctx);
		assert.equal(fs.readFileSync(record.outputFile, "utf-8"), "preserved result\n");
		assert.match(
			fs.readFileSync(record.stdoutFile, "utf-8"),
			/legacy stdout compacted.*16777217/,
		);
	} finally {
		cleanupTestCtx(ctx, sessionId);
	}
});

test("reconcile streams a large child session and recovers its final assistant message", async () => {
	const { sessionId, ctx } = makeTestCtx("pi-subagents-stream-session");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);
	const dir = path.join(sessionId, "subagents", "stream-a");
	fs.mkdirSync(dir, { recursive: true });
	const sessionFile = path.join(dir, "2026-01-01T00-00-00-000Z_stream-a.jsonl");
	fs.writeFileSync(sessionFile, Buffer.alloc(16 * 1024 * 1024 + 1, 0x78));
	fs.appendFileSync(
		sessionFile,
		`\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "recovered final answer" }] } })}\n`,
	);
	const record = { id: "stream-a", parentSessionId: sessionId, cwd: ctx.cwd, taskPreview: "x", running: true, sessionDir: dir, outputFile: path.join(dir, "result.log"), stdoutFile: path.join(dir, "stdout.log"), stderrFile: path.join(dir, "stderr.log"), createdAt: Date.now(), updatedAt: Date.now() };
	fs.writeFileSync(record.stdoutFile, "unused stdout");
	fs.writeFileSync(record.stderrFile, "");
	fs.writeFileSync(storeFile(sessionId), JSON.stringify({ records: [record] }, null, 2));
	const { handlers } = registerTestTools(() => {});
	try {
		await handlers.get("session_start")(undefined, fake.ctx);
		const persisted = readPersistedRecord(sessionId, "stream-a");
		assert.equal(persisted.running, false);
		assert.equal(persisted.error, undefined);
		assert.equal(fs.readFileSync(record.outputFile, "utf-8"), "recovered final answer\n");
	} finally {
		cleanupTestCtx(ctx, sessionId);
	}
});

// ── Lifeline: process-death cascade via anonymous pipe ──

import { PI_SUBAGENT_LIFELINE_FD } from "../../src/runs/shared/subagent-prompt-runtime.ts";

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessDeath(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`process ${pid} did not die within ${timeoutMs}ms`);
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	throw new Error(`file ${filePath} not created within ${timeoutMs}ms`);
}

async function waitForChildExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
		}, timeoutMs);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			clearTimeout(timer);
			resolve({ code, signal });
		};
		child.once("exit", onExit);
	});
}

function spawnLifelineRuntimeFixture(readyFile: string, keepAlive: boolean): {
	child: ChildProcess;
	lifeline: Writable;
	stderr: () => string;
} {
	const runtimePath = path.join(
		projectRoot,
		"src",
		"runs",
		"shared",
		"subagent-prompt-runtime.ts",
	);
	const script = `
		import ${JSON.stringify(runtimePath)};
		import fs from "node:fs";
		fs.writeFileSync(${JSON.stringify(readyFile)}, "ready", "utf-8");
		${keepAlive ? "setInterval(() => {}, 60_000);" : ""}
	`;
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", script],
		{
			cwd: projectRoot,
			env: {
				...process.env,
				[PI_SUBAGENT_LIFELINE_FD]: "3",
			},
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		},
	);
	const lifeline = child.stdio[3] as Writable | null;
	assert.ok(lifeline, "fixture lifeline pipe must exist");
	let stderr = "";
	child.stderr?.setEncoding("utf-8");
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	return { child, lifeline, stderr: () => stderr };
}

function cleanupLifelineRuntimeFixture(
	child: ChildProcess,
	lifeline: Writable,
): void {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
	lifeline.destroy();
}

test("lifeline: subagent-prompt-runtime exposes lifeline env constant", () => {
	assert.equal(typeof PI_SUBAGENT_LIFELINE_FD, "string");
	assert.ok(PI_SUBAGENT_LIFELINE_FD.length > 0);
});

test("lifeline: watcher does not retain an otherwise idle child", async () => {
	const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-lifeline-idle-"));
	const fixture = spawnLifelineRuntimeFixture(path.join(testDir, "ready"), false);

	try {
		await waitForFile(path.join(testDir, "ready"), 2000);
		const result = await waitForChildExit(fixture.child, 2000);
		assert.equal(result.code, 0, fixture.stderr());
		assert.equal(result.signal, null, fixture.stderr());
	} finally {
		cleanupLifelineRuntimeFixture(fixture.child, fixture.lifeline);
		fs.rmSync(testDir, { recursive: true, force: true });
	}
});

test("lifeline: parent EOF still terminates an active child", async () => {
	const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-lifeline-eof-"));
	const fixture = spawnLifelineRuntimeFixture(path.join(testDir, "ready"), true);

	try {
		await waitForFile(path.join(testDir, "ready"), 2000);
		fixture.lifeline.end();
		await waitForChildExit(fixture.child, 2000);
	} finally {
		cleanupLifelineRuntimeFixture(fixture.child, fixture.lifeline);
		fs.rmSync(testDir, { recursive: true, force: true });
	}
});

test("lifeline: session_shutdown terminates children via lifeline", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({
		output: "lifeline-kill done",
		exitCode: 0,
		delay: 60,
		keepAliveAfterFinalMessageMs: 300,
	});

	const { sessionId, ctx } = makeTestCtx("pi-subagents-lifeline-kill");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);

	const sessionShutdownHandlers: Array<(_event: unknown, ctx: unknown) => void> = [];
	const registered = new Map<string, any>();
	registerSubagentExtension({
		registerTool(tool: any) { registered.set(tool.name, tool); },
		sendMessage() {},
		on(event: string, handler: any) {
			if (event === "session_shutdown") sessionShutdownHandlers.push(handler);
		},
	} as never);
	const spawnTool = registered.get("spawn_subagent");
	assert.ok(spawnTool, "spawn_subagent tool registered");

	try {
		const result = await spawnTool.execute(
			"lifeline-kill-child",
			{ task: "lifeline kill test" },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		const childId = result.details.id;
		await waitForSubagentRecord(sessionId, childId, (r) => r.running === true);
		const record = readPersistedRecord(sessionId, childId);
		assert.equal(record.running, true);
		assert.ok(typeof record.pid === "number");
		assert.ok(isProcessAlive(record.pid), "child must be alive before lifeline close");

		assert.ok(sessionShutdownHandlers.length >= 1, "session_shutdown handler registered");
		sessionShutdownHandlers.forEach((h) => h(undefined, fake.ctx));

		await waitForProcessDeath(record.pid, 2000);
		assert.equal(isProcessAlive(record.pid), false, "child must die after session_shutdown");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("lifeline: agent_end does NOT kill child process", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "agent-end-survive done", exitCode: 0, delay: 200 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-agent-end-survive");
	const fake = makeFakeCtx(sessionId, ctx.cwd, false);

	const agentEndHandlers: Array<(_event: unknown, ctx: unknown) => void> = [];
	const registered = new Map<string, any>();
	registerSubagentExtension({
		registerTool(tool: any) { registered.set(tool.name, tool); },
		sendMessage() {},
		on(event: string, handler: any) {
			if (event === "agent_end") agentEndHandlers.push(handler);
		},
	} as never);
	const spawnTool = registered.get("spawn_subagent");

	try {
		const result = await spawnTool.execute(
			"agent-end-survive-child",
			{ task: "survive agent_end" },
			new AbortController().signal,
			undefined,
			fake.ctx,
		);
		const childId = result.details.id;
		await waitForSubagentRecord(sessionId, childId, (r) => r.running === true);
		const record = readPersistedRecord(sessionId, childId);
		assert.ok(isProcessAlive(record.pid), "child must be alive before agent_end");

		assert.ok(agentEndHandlers.length >= 1);
		agentEndHandlers.forEach((h) => h(undefined, fake.ctx));

		await new Promise((r) => setTimeout(r, 80));
		assert.ok(isProcessAlive(record.pid), "child must survive agent_end");

		await waitForSubagentRecord(sessionId, childId, (r) => r.running === false);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("lifeline: abrupt parent SIGKILL cascades to child termination", async () => {
	const extensionPath = path.join(projectRoot, "src", "index.ts");
	const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cascade-"));
	const parentSessionId = testDir;
	const sessionFile = path.join(testDir, "session.jsonl");

	const parentScript = `
		import fs from "node:fs";
		import registerSubagentExtension from ${JSON.stringify(extensionPath)};

		const registered = new Map();
		registerSubagentExtension({
			registerTool(tool) { registered.set(tool.name, tool); },
			sendMessage() {},
			on() {},
		});

		const ctx = {
			cwd: ${JSON.stringify(testDir)},
			hasUI: false,
			sessionManager: {
				getSessionFile: () => ${JSON.stringify(sessionFile)},
				getSessionId: () => ${JSON.stringify(sessionFile)},
			},
		};

		const result = await registered.get("spawn_subagent").execute(
			"cascade-child",
			{ task: "long-running cascade child" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		fs.writeFileSync(${JSON.stringify(path.join(testDir, "ready"))}, JSON.stringify({
			childId: result.details.id,
		}), "utf-8");

		setTimeout(() => {}, 60000);
	`;

	const parentProc = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", parentScript],
		{ cwd: projectRoot, env: { ...process.env, PI_NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);

	try {
		const readyContent = await waitForFile(path.join(testDir, "ready"), 10000);
		const { childId } = JSON.parse(readyContent) as { childId: string };

		const childRecord = readPersistedRecord(parentSessionId, childId);
		assert.ok(childRecord, "child record must exist");
		assert.equal(childRecord.running, true);
		const childPid = childRecord.pid;
		assert.ok(typeof childPid === "number" && childPid > 0);
		assert.ok(isProcessAlive(childPid), "child must be alive before parent kill");

		assert.ok(parentProc.pid);
		process.kill(parentProc.pid, "SIGKILL");

		await waitForProcessDeath(childPid, 5000);
		assert.equal(isProcessAlive(childPid), false, "child must die after parent SIGKILL");
	} finally {
		try { process.kill(parentProc.pid as number, "SIGKILL"); } catch {}
		try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
	}
});

test("lifeline: recursive cascade — grandparent death kills parent subagent", async () => {
	const extensionPath = path.join(projectRoot, "src", "index.ts");
	const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-recursive-"));
	const sessionFile = path.join(testDir, "session.jsonl");

	const grandparentScript = `
		import fs from "node:fs";
		import registerSubagentExtension from ${JSON.stringify(extensionPath)};

		const registered = new Map();
		registerSubagentExtension({
			registerTool(tool) { registered.set(tool.name, tool); },
			sendMessage() {},
			on() {},
		});

		const ctx = {
			cwd: ${JSON.stringify(testDir)},
			hasUI: false,
			sessionManager: {
				getSessionFile: () => ${JSON.stringify(sessionFile)},
				getSessionId: () => ${JSON.stringify(sessionFile)},
			},
		};

		const result = await registered.get("spawn_subagent").execute(
			"recursive-parent",
			{ task: "parent that spawns child" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		fs.writeFileSync(${JSON.stringify(path.join(testDir, "ready"))}, JSON.stringify({
			parentId: result.details.id,
		}), "utf-8");

		setTimeout(() => {}, 60000);
	`;

	const grandparentProc = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", grandparentScript],
		{ cwd: projectRoot, env: { ...process.env, PI_NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);

	try {
		const readyContent = await waitForFile(path.join(testDir, "ready"), 15000);
		const { parentId } = JSON.parse(readyContent) as { parentId: string };

		const parentRecord = readPersistedRecord(testDir, parentId);
		assert.ok(parentRecord, "parent record must exist");
		const parentPid = parentRecord.pid;
		assert.ok(typeof parentPid === "number" && parentPid > 0);
		assert.ok(isProcessAlive(parentPid), "parent subagent must be alive");

		process.kill(grandparentProc.pid as number, "SIGKILL");

		await waitForProcessDeath(parentPid, 5000);
		assert.equal(isProcessAlive(parentPid), false, "parent subagent must die after grandparent SIGKILL");
	} finally {
		try { process.kill(grandparentProc.pid as number, "SIGKILL"); } catch {}
		try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
	}
});
// ── Bug: model inheritance ──

test("model inheritance: omitted model inherits parent active model", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "inherited model done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-model-inherit");
	// Simulate a parent context with an active model
	const parentModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
	const ctxWithModel = {
		...ctx,
		model: parentModel,
	};
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"inherit-model-child",
			{ task: "echo model" },
			new AbortController().signal,
			undefined,
			ctxWithModel,
		);
		await waitForPersistedRecord(sessionId, result.details.id);

		// Verify --model was passed to child with the parent's active model
		const captured = readLatestMockPiArgs(mockPi).args;
		const modelIdx = captured.indexOf("--model");
		assert.ok(modelIdx !== -1, "--model must be passed to child");
		const modelValue = captured[modelIdx + 1];
		assert.equal(modelValue, "openai-codex/gpt-5.6-sol");

		// Verify record persisted the model
		const record = readPersistedRecord(sessionId, result.details.id);
		assert.equal(record.model, "openai-codex/gpt-5.6-sol");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("model inheritance: explicit model overrides inherited model", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "explicit model done", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-model-override");
	const parentModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
	const ctxWithModel = {
		...ctx,
		model: parentModel,
	};
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"explicit-model-child",
			{ task: "echo model", model: "anthropic/claude-sonnet-4-5" },
			new AbortController().signal,
			undefined,
			ctxWithModel,
		);
		await waitForPersistedRecord(sessionId, result.details.id);

		const captured = readLatestMockPiArgs(mockPi).args;
		const modelIdx = captured.indexOf("--model");
		assert.ok(modelIdx !== -1);
		const modelValue = captured[modelIdx + 1];
		assert.equal(modelValue, "anthropic/claude-sonnet-4-5");

		const record = readPersistedRecord(sessionId, result.details.id);
		assert.equal(record.model, "anthropic/claude-sonnet-4-5");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

// ── Bug: fatal-error lifecycle ──

test("error lifecycle: provider runtime failure marks child failed promptly", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	// The child prompt runtime turns terminal provider failures into stderr and
	// a non-zero exit; its prompt lifecycle behavior is tested separately above.
	mockPi.onCall({
		stderr: "HTTP 402 Payment Required\n",
		exitCode: 1,
	});

	const { sessionId, ctx } = makeTestCtx("pi-subagents-error-lifecycle");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"error-child",
			{ task: "do work" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		let record: Record<string, any> | undefined;
		for (let i = 0; i < 200; i++) {
			record = readPersistedRecord(sessionId, result.details.id);
			if (record && !record.running) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(record, "record must exist");

		// Child must be marked as not running
		assert.equal(record.running, false, "record must show running=false");
		// completedAt must be set
		assert.ok(record.completedAt, "completedAt must be set");
		// Error text must be captured
		assert.ok(record.error, "error must be set");
		assert.match(record.error, /HTTP 402 Payment Required/);
		// result must be set
		assert.ok(record.result, "result must be set (file path)");

		// Verify result.log has (error) fallback
		const resultContent = fs.readFileSync(record.result, "utf-8");
		assert.equal(resultContent.trim(), "(error)");
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("error lifecycle: no duplicate completion notification on provider error", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({
		stderr: "HTTP 402 Payment Required\n",
		exitCode: 1,
	});

	const { sessionId, ctx } = makeTestCtx("pi-subagents-error-dedup");
	let notifyCount = 0;
	const { spawnTool } = registerTestTools(() => {
		notifyCount += 1;
	});

	try {
		const result = await spawnTool.execute(
			"error-dedup-child",
			{ task: "do work" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		await waitForPersistedRecord(sessionId, result.details.id);
		assert.equal(
			notifyCount,
			1,
			"completion notification must fire exactly once",
		);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("error lifecycle: normal successful completion unchanged", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "success output", exitCode: 0 });

	const { sessionId, ctx } = makeTestCtx("pi-subagents-error-normal");
	const { spawnTool } = registerTestTools(() => {});

	try {
		const result = await spawnTool.execute(
			"normal-child",
			{ task: "do work" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const record = await waitForPersistedRecord(sessionId, result.details.id);
		assert.equal(record.running, false);
		assert.equal(record.error, undefined);
		assert.ok(record.completedAt);
		const resultContent = fs.readFileSync(record.result, "utf-8");
		assert.match(resultContent, /success output/);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});

test("error lifecycle: lifeline cleanup unchanged after provider error", async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({
		stderr: "HTTP 402 Payment Required\n",
		exitCode: 1,
	});

	const { sessionId, ctx } = makeTestCtx("pi-subagents-error-lifeline");
	const messages: string[] = [];
	const { spawnTool } = registerTestTools((message: any) => {
		messages.push(String(message.content ?? ""));
	});

	try {
		const result = await spawnTool.execute(
			"lifeline-error-child",
			{ task: "do work" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		let record: Record<string, any> | undefined;
		for (let i = 0; i < 200; i++) {
			record = readPersistedRecord(sessionId, result.details.id);
			if (record && !record.running) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(record, "record must exist");

		// Completion notification must fire
		const completionMsg = messages.find((m) =>
			m.includes(record!.id) && m.includes("completed"),
		);
		assert.ok(completionMsg, "completion notification must fire");

		// running must be false
		assert.equal(record.running, false);
		// pendingCompletionNotice must be false (notification was sent)
		assert.equal(record.pendingCompletionNotice, false);
		assert.equal(record.notifiedCompletion, true);
	} finally {
		mockPi.uninstall();
		cleanupTestCtx(ctx, sessionId);
	}
});
