import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildModuleGraph,
	clearModuleGraphCache,
	findModuleForPath,
	getDownstreamModules,
	getModuleSourceFiles,
} from "../../clients/review-graph/workspace-modules.ts";
import { setupTestEnvironment } from "./test-utils.js";

function write(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

describe("workspace module graph", () => {
	it("expands pnpm workspace globs and computes downstream dependents", () => {
		const env = setupTestEnvironment("pi-lens-workspace-modules-pnpm-");
		try {
			write(
				path.join(env.tmpDir, "pnpm-workspace.yaml"),
				"packages:\n  - 'packages/*'\n",
			);
			write(
				path.join(env.tmpDir, "packages/core/package.json"),
				JSON.stringify({ name: "@demo/core" }),
			);
			write(
				path.join(env.tmpDir, "packages/app/package.json"),
				JSON.stringify({
					name: "@demo/app",
					dependencies: { "@demo/core": "workspace:*" },
				}),
			);
			write(
				path.join(env.tmpDir, "packages/app/src/index.ts"),
				"export const app = 1;\n",
			);

			clearModuleGraphCache();
			const graph = buildModuleGraph(env.tmpDir);
			expect(graph?.modules.has("@demo/core")).toBe(true);
			expect(graph?.modules.has("@demo/app")).toBe(true);
			expect(graph?.modules.get("@demo/app")?.internalDeps).toEqual([
				"@demo/core",
			]);
			expect(getDownstreamModules(graph!, "@demo/core")).toEqual(["@demo/app"]);
		} finally {
			clearModuleGraphCache();
			env.cleanup();
		}
	});

	it("finds owning module and recursively scans source files", () => {
		const env = setupTestEnvironment("pi-lens-workspace-modules-files-");
		try {
			write(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ workspaces: ["packages/*"] }),
			);
			write(
				path.join(env.tmpDir, "packages/lib/package.json"),
				JSON.stringify({ name: "lib" }),
			);
			const source = path.join(env.tmpDir, "packages/lib/src/nested/util.ts");
			write(source, "export const util = 1;\n");
			write(
				path.join(env.tmpDir, "packages/lib/dist/generated.ts"),
				"export const generated = 1;\n",
			);

			clearModuleGraphCache();
			const graph = buildModuleGraph(env.tmpDir)!;
			expect(findModuleForPath(graph, source)?.name).toBe("lib");
			const files = getModuleSourceFiles(path.join(env.tmpDir, "packages/lib"));
			expect(files.some((file) => file.endsWith("/src/nested/util.ts"))).toBe(
				true,
			);
			expect(files.some((file) => file.includes("/dist/"))).toBe(false);
		} finally {
			clearModuleGraphCache();
			env.cleanup();
		}
	});
});
