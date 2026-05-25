import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type TestRunnerName = "vitest" | "jest" | "npm";

export interface DetectedTestRunner {
	runner: TestRunnerName;
	config: string | null;
}

export interface TestRunTarget extends DetectedTestRunner {
	testFile: string;
	strategy: "self" | "sibling";
}

export interface TestSuggestion extends DetectedTestRunner {
	testFile: string;
	sourceFile: string;
}

export interface TestRunResult {
	file: string;
	runner: TestRunnerName;
	passed: number;
	failed: number;
	duration: number;
	output: string;
	error?: string;
}

const TEST_FILE_RE = /(?:^|[.\-/])(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;

function fileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function findUp(startDir: string, names: readonly string[]): string | null {
	let dir = path.resolve(startDir);
	const root = path.parse(dir).root;
	while (true) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (fileExists(candidate)) return candidate;
		}
		if (dir === root) return null;
		dir = path.dirname(dir);
	}
}

function isTestFile(filePath: string): boolean {
	return TEST_FILE_RE.test(path.basename(filePath));
}

function siblingTestCandidates(filePath: string): string[] {
	const ext = path.extname(filePath);
	const base = filePath.slice(0, -ext.length);
	return [
		`${base}.test${ext}`,
		`${base}.spec${ext}`,
		path.join(path.dirname(filePath), "__tests__", `${path.basename(base)}.test${ext}`),
		path.join(path.dirname(filePath), "__tests__", `${path.basename(base)}.spec${ext}`),
	];
}

function parseVitestOutput(output: string): Pick<TestRunResult, "passed" | "failed"> {
	const failedMatch = output.match(/(?:^|\s)(\d+)\s+failed\b/);
	const passedMatch = output.match(/(?:^|\s)(\d+)\s+passed\b/);
	return {
		passed: passedMatch ? Number(passedMatch[1]) : 0,
		failed: failedMatch ? Number(failedMatch[1]) : 0,
	};
}

export class TestRunnerClient {
	detectRunner(cwd: string): DetectedTestRunner | null {
		const vitestConfig = findUp(cwd, [
			"vitest.config.ts",
			"vitest.config.mts",
			"vitest.config.js",
			"vite.config.ts",
		]);
		if (vitestConfig) return { runner: "vitest", config: vitestConfig };

		const jestConfig = findUp(cwd, [
			"jest.config.ts",
			"jest.config.js",
			"jest.config.cjs",
		]);
		if (jestConfig) return { runner: "jest", config: jestConfig };

		const packageJson = findUp(cwd, ["package.json"]);
		if (!packageJson) return null;
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
				scripts?: Record<string, string>;
				devDependencies?: Record<string, string>;
				dependencies?: Record<string, string>;
			};
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			if (deps.vitest || pkg.scripts?.test?.includes("vitest")) {
				return { runner: "vitest", config: null };
			}
			if (deps.jest || pkg.scripts?.test?.includes("jest")) {
				return { runner: "jest", config: null };
			}
			if (pkg.scripts?.test) return { runner: "npm", config: null };
		} catch {
			return null;
		}
		return null;
	}

	getTestRunTarget(filePath: string, cwd: string): TestRunTarget | null {
		const detected = this.detectRunner(cwd);
		if (!detected) return null;
		const abs = path.resolve(filePath);
		if (isTestFile(abs)) return { ...detected, testFile: abs, strategy: "self" };
		if (!SOURCE_EXT_RE.test(abs)) return null;
		const sibling = siblingTestCandidates(abs).find(fileExists);
		return sibling ? { ...detected, testFile: sibling, strategy: "sibling" } : null;
	}

	suggestTestFiles(filePaths: string[], cwd: string): TestSuggestion[] {
		const detected = this.detectRunner(cwd);
		if (!detected) return [];
		const suggestions: TestSuggestion[] = [];
		const seen = new Set<string>();
		for (const filePath of filePaths) {
			const target = this.getTestRunTarget(filePath, cwd);
			if (target && !seen.has(target.testFile)) {
				seen.add(target.testFile);
				suggestions.push({
					...detected,
					testFile: target.testFile,
					sourceFile: path.resolve(filePath),
				});
			}
		}
		return suggestions;
	}

	runTestFileAsync(
		testFile: string,
		cwd: string,
		runner: TestRunnerName,
		config: string | null,
	): Promise<TestRunResult> {
		const start = Date.now();
		const args = this.buildArgs(testFile, runner, config);
		const command = args.shift();
		if (!command) {
			return Promise.resolve({
				file: testFile,
				runner,
				passed: 0,
				failed: 0,
				duration: 0,
				output: "",
				error: "no test command",
			});
		}

		return new Promise((resolve) => {
			const child = spawn(command, args, { cwd, shell: process.platform === "win32" });
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.on("error", (error) => {
				resolve({
					file: testFile,
					runner,
					passed: 0,
					failed: 0,
					duration: Date.now() - start,
					output,
					error: error.message,
				});
			});
			child.on("close", (code) => {
				const counts = parseVitestOutput(output);
				resolve({
					file: testFile,
					runner,
					passed: counts.passed,
					failed: code === 0 ? counts.failed : Math.max(1, counts.failed),
					duration: Date.now() - start,
					output,
					error: code === 0 ? undefined : `test command exited with ${code}`,
				});
			});
		});
	}

	formatResult(result: TestRunResult): string {
		if (result.failed === 0 && !result.error) return "";
		const header = `🧪 ${result.runner} failed for ${path.basename(result.file)} (${result.duration}ms)`;
		const body = result.output.trim().split("\n").slice(-80).join("\n");
		return body ? `${header}\n${body}` : `${header}\n${result.error ?? "unknown failure"}`;
	}

	private buildArgs(
		testFile: string,
		runner: TestRunnerName,
		config: string | null,
	): string[] {
		if (runner === "vitest") {
			return [
				"npx",
				"vitest",
				"run",
				...(config ? ["--config", config] : []),
				testFile,
			];
		}
		if (runner === "jest") {
			return ["npx", "jest", ...(config ? ["--config", config] : []), testFile];
		}
		return ["npm", "test", "--", testFile];
	}
}
