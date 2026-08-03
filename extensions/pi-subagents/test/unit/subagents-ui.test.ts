import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerSubagentExtension from "../../src/extension/index.ts";

interface TestRecord {
	id: string;
	taskPreview: string;
	running: boolean;
	pid?: number;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	cwd?: string;
	model?: string;
	outputFile?: string;
	stdoutFile?: string;
	stderrFile?: string;
}

function setup(records: TestRecord[]) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ui-"));
	const sessionFile = path.join(cwd, "session.jsonl");
	const storeDir = path.join(cwd, "subagents");
	fs.mkdirSync(storeDir, { recursive: true });
	fs.writeFileSync(
		path.join(storeDir, "subagents.json"),
		JSON.stringify({
			records: records.map((record) => ({
				parentSessionId: cwd,
				cwd,
				stdoutFile: path.join(cwd, `${record.id}.stdout.log`),
				stderrFile: path.join(cwd, `${record.id}.stderr.log`),
				...record,
			})),
		}),
	);

	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const pi = {
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		registerShortcut(key: string, definition: any) {
			shortcuts.set(key, definition);
		},
		on() {},
	};
	registerSubagentExtension(pi as never);

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const renders: string[][] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const ui = {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
		async custom(factory: any) {
			let result: unknown;
			let done = false;
			const component = factory(
				{ requestRender() {} },
				theme,
				{},
				(value: unknown) => {
					result = value;
					done = true;
				},
			);
			renders.push(component.render(240));
			const action = actions.shift() ?? "escape";
			if (action === "down-enter" || action === "down-up-enter") {
				component.handleInput?.("\x1b[B");
				if (action === "down-up-enter") component.handleInput?.("\x1b[A");
				component.handleInput?.("\r");
			} else {
				component.handleInput?.(action === "enter" ? "\r" : "\x1b");
			}
			assert.equal(done, true, `UI action ${action} should close current view`);
			return result;
		},
	};
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		ui,
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionFile,
		},
	};
	const actions: string[] = [];

	return {
		commands,
		shortcuts,
		ctx,
		renders,
		notifications,
		actions,
		cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
	};
}

test("registers /subagents and Ctrl+Shift+S", () => {
	const harness = setup([]);
	try {
		assert.equal(harness.commands.get("subagents")?.description, "List subagents");
		assert.equal(harness.shortcuts.get("ctrl+shift+s")?.description, "List subagents");
	} finally {
		harness.cleanup();
	}
});

test("/subagents lists all statuses, sanitizes previews, and opens selected read-only details", async () => {
	const now = Date.now();
	const harness = setup([
		{ id: "running-12345678", taskPreview: "run\n\x1b[31mred\x1b[0m\u0007 task", running: true, pid: process.pid, createdAt: now - 5_000, updatedAt: now },
		{ id: "completed-1234", taskPreview: "done task", running: false, createdAt: now - 8_000, updatedAt: now - 2_000, completedAt: now - 2_000, model: "openai/test" },
		{ id: "error-12345678", taskPreview: "error task", running: false, createdAt: now - 7_000, updatedAt: now - 1_000, completedAt: now - 1_000, error: "provider failed" },
		{ id: "timeout-123456", taskPreview: "timeout task", running: false, createdAt: now - 9_000, updatedAt: now - 1_000, completedAt: now - 1_000, error: "Operation timed out" },
	]);
	try {
		harness.actions.push("down-enter", "escape");
		await harness.commands.get("subagents").handler("", harness.ctx);

		assert.equal(harness.renders.length, 2);
		const list = harness.renders[0].join("\n");
		assert.match(list, /running\s+\d+s/);
		assert.match(list, /completed\s+6s/);
		assert.match(list, /error\s+6s/);
		assert.match(list, /timed-out\s+8s/);
		assert.match(list, /run red task/);
		assert.doesNotMatch(list, /\x1b|\u0007|run\nred/);
		assert.match(list, /↑↓ navigate • enter details • esc cancel/);

		const details = harness.renders[1].join("\n");
		assert.match(details, /Subagent details/);
		assert.match(details, /ID: completed-1234/);
		assert.match(details, /Status: completed/);
		assert.match(details, /Model: openai\/test/);
		assert.match(details, /Task: done task/);
		assert.match(details, /enter\/esc close/);
	} finally {
		harness.cleanup();
	}
});

test("Up reverses Down before Enter", async () => {
	const now = Date.now();
	const harness = setup([
		{ id: "first-123456789", taskPreview: "first", running: false, createdAt: now - 2_000, updatedAt: now, completedAt: now },
		{ id: "second-12345678", taskPreview: "second", running: false, createdAt: now - 1_000, updatedAt: now, completedAt: now },
	]);
	try {
		harness.actions.push("down-up-enter", "enter");
		await harness.commands.get("subagents").handler("", harness.ctx);
		assert.match(harness.renders[1].join("\n"), /ID: first-123456789/);
	} finally {
		harness.cleanup();
	}
});

test("shortcut and command open the same list and Escape cancels", async () => {
	const now = Date.now();
	const harness = setup([
		{ id: "same-ui-12345678", taskPreview: "same UI", running: false, createdAt: now - 1_000, updatedAt: now, completedAt: now },
	]);
	try {
		harness.actions.push("escape", "escape");
		await harness.commands.get("subagents").handler("", harness.ctx);
		await harness.shortcuts.get("ctrl+shift+s").handler(harness.ctx);
		assert.equal(harness.renders.length, 2);
		assert.deepEqual(harness.renders[1], harness.renders[0]);
		assert.match(harness.renders[0].join("\n"), /same UI/);
	} finally {
		harness.cleanup();
	}
});

test("headless legacy context does not open custom TUI", async () => {
	const now = Date.now();
	const harness = setup([
		{ id: "headless-123456", taskPreview: "headless", running: false, createdAt: now - 1_000, updatedAt: now, completedAt: now },
	]);
	try {
		(harness.ctx as typeof harness.ctx & { mode?: string }).mode = undefined;
		harness.ctx.hasUI = false;
		await harness.commands.get("subagents").handler("", harness.ctx);
		assert.deepEqual(harness.renders, []);
		assert.deepEqual(harness.notifications, [
			{ message: "/subagents requires TUI mode", level: "error" },
		]);
	} finally {
		harness.cleanup();
	}
});
