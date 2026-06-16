import { describe, expect, test } from "bun:test";
import { buildPiCommand } from "../src/zv-core.ts";

describe("buildPiCommand", () => {
	test("starts fresh pi with optional prompt by default", () => {
		expect(buildPiCommand("/repo with space", { prompt: "review this" })).toBe(
			"cd '/repo with space' && exec pi 'review this'",
		);
	});

	test("can start pi from a forked session and preserve initial prompt", () => {
		expect(buildPiCommand("/repo with space", { fork: "/tmp/current session.jsonl", prompt: "keep going" })).toBe(
			"cd '/repo with space' && exec pi --fork '/tmp/current session.jsonl' 'keep going'",
		);
	});
});
