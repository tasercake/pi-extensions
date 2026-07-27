import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";

export const STDOUT_LOG_MAX_BYTES = 16 * 1024 * 1024;
export const STDERR_LOG_MAX_BYTES = 4 * 1024 * 1024;
const TRUNCATION_MARKER = Buffer.from("\n[pi-subagents log truncated]\n");

/**
 * Consumes an entire child stream while persisting at most maxBytes. Keeping
 * consumption separate from persistence prevents a capped log from blocking
 * the child process on a full stdout/stderr pipe.
 */
export class CappedLogWriter extends Writable {
	private fd: number | undefined;
	private remaining: number;
	private truncated = false;

	constructor(filePath: string, maxBytes: number) {
		super();
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
			throw new Error(`maxBytes must be a non-negative safe integer: ${maxBytes}`);
		}
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		let existingBytes = 0;
		try {
			existingBytes = fs.statSync(filePath).size;
		} catch (error) {
			if (
				!error ||
				typeof error !== "object" ||
				!("code" in error) ||
				error.code !== "ENOENT"
			) {
				throw error;
			}
		}
		this.remaining = Math.max(0, maxBytes - existingBytes);
		this.fd = fs.openSync(filePath, "a", 0o600);
	}

	override _write(
		chunk: Buffer | string,
		encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		try {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
			if (buffer.length <= this.remaining) {
				this.writeBuffer(buffer);
				callback();
				return;
			}

			if (!this.truncated && this.remaining > 0) {
				this.truncated = true;
				const markerBytes = Math.min(TRUNCATION_MARKER.length, this.remaining);
				const payloadBytes = Math.max(0, this.remaining - markerBytes);
				this.writeBuffer(buffer.subarray(0, payloadBytes));
				this.writeBuffer(TRUNCATION_MARKER.subarray(0, markerBytes));
			} else {
				this.truncated = true;
			}
			callback();
		} catch (error) {
			callback(error instanceof Error ? error : new Error(String(error)));
		}
	}

	override _final(callback: (error?: Error | null) => void): void {
		try {
			this.closeFile();
			callback();
		} catch (error) {
			callback(error instanceof Error ? error : new Error(String(error)));
		}
	}

	override _destroy(
		error: Error | null,
		callback: (error?: Error | null) => void,
	): void {
		try {
			this.closeFile();
			callback(error);
		} catch (closeError) {
			callback(
				closeError instanceof Error ? closeError : new Error(String(closeError)),
			);
		}
	}

	private writeBuffer(buffer: Buffer): void {
		if (buffer.length === 0 || this.remaining === 0) return;
		if (this.fd === undefined) throw new Error("log file is closed");
		const length = Math.min(buffer.length, this.remaining);
		let offset = 0;
		while (offset < length) {
			offset += fs.writeSync(this.fd, buffer, offset, length - offset);
		}
		this.remaining -= length;
	}

	private closeFile(): void {
		if (this.fd === undefined) return;
		const fd = this.fd;
		this.fd = undefined;
		fs.closeSync(fd);
	}
}
