import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TestEnvironment {
	tmpDir: string;
	cleanup: () => void;
}

export function setupTestEnvironment(prefix = "pi-lens-test-"): TestEnvironment {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		tmpDir,
		cleanup: () => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

export function createTempFile(
	rootDir: string,
	relativePath: string,
	content: string,
): string {
	const filePath = path.join(rootDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}
