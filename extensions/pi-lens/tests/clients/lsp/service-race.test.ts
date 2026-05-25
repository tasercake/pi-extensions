import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const stopLSP = vi.fn();

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("timed out waiting for condition");
}

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

vi.mock("../../../clients/lsp/launch.js", () => ({
	stopLSP,
}));

describe("LSPService race hardening", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		stopLSP.mockReset();
		stopLSP.mockResolvedValue(undefined);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("deduplicates concurrent spawn for same server/root key", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return {
				process: {
					process: { killed: false },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 123,
				},
			};
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		const [a, b, c] = await Promise.all([
			service.getClientForFile(file),
			service.getClientForFile(file),
			service.getClientForFile(file),
		]);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(a?.client).toBeTruthy();
		expect(b?.client).toBeTruthy();
		expect(c?.client).toBeTruthy();
	});

	it("retries broken server after cooldown window", async () => {
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => undefined);
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		await service.getClientForFile(file);
		await service.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(1);

		now.mockReturnValue(16_000);
		await service.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(2);
		now.mockRestore();
	}, 15000);

	it("shutdown while server spawn is in flight kills the late raw process", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const spawnDeferred = deferred<any>();
		const fakeProcess = {
			process: { killed: false },
			stdin: {} as any,
			stdout: {} as any,
			stderr: {} as any,
			pid: 789,
		};
		const spawn = vi.fn(() => spawnDeferred.promise);

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: async () => "/repo",
				spawn,
			},
		]);

		const request = service.getClientForFile("/repo/main.ts");
		await waitUntil(() => spawn.mock.calls.length > 0);

		const shutdown = service.shutdown();
		spawnDeferred.resolve({ process: fakeProcess });

		await expect(request).resolves.toBeUndefined();
		await shutdown;

		expect(createLSPClient).not.toHaveBeenCalled();
		expect(stopLSP).toHaveBeenCalledWith(fakeProcess);
		expect(service.getAliveClientCount()).toBe(0);
	});

	it("shutdown during async root lookup does not spawn", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const rootDeferred = deferred<string>();
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 790,
			},
		}));

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: vi.fn(() => rootDeferred.promise),
				spawn,
			},
		]);

		const request = service.getClientForFile("/repo/main.ts");
		const shutdown = service.shutdown();
		rootDeferred.resolve("/repo");

		await shutdown;
		await expect(request).resolves.toBeUndefined();

		expect(spawn).not.toHaveBeenCalled();
		expect(createLSPClient).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(0);
	});

	it("shutdown while createLSPClient is in flight shuts down the late client", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const clientDeferred = deferred<any>();
		const shutdownSpy = vi.fn(async () => {});
		createLSPClient.mockReturnValue(clientDeferred.promise);

		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 791,
			},
		}));

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: async () => "/repo",
				spawn,
			},
		]);

		const request = service.getClientForFile("/repo/main.ts");
		await waitUntil(() => createLSPClient.mock.calls.length > 0);

		const shutdown = service.shutdown();
		clientDeferred.resolve({ isAlive: () => true, shutdown: shutdownSpy });

		await expect(request).resolves.toBeUndefined();
		await shutdown;

		expect(shutdownSpy).toHaveBeenCalledTimes(1);
		expect(service.getAliveClientCount()).toBe(0);
	});

	it("uses a server-specific wait budget override for slow startup", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return {
				process: {
					process: { killed: false },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 456,
				},
			};
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "ruby",
				name: "Ruby LSP",
				extensions: [".rb"],
				root: async () => "C:/repo",
				clientWaitTimeoutMs: 50,
				spawn,
			},
		]);

		const file = "C:/repo/main.rb";
		const result = await service.getClientForFile(file, 1);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(result?.client).toBeTruthy();
	});
});
