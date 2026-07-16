import test from "node:test";
import assert from "node:assert/strict";
import { AgentmemoryError, asAgentmemoryError, formatDiagnostic } from "../src/errors.js";

test("typed errors retain only safe diagnostics", () => {
  const error = new AgentmemoryError("unauthorized", "health failed", { endpoint: "https://e.test", operation: "health", status: 401, reason: "unauthorized" }, { status: 401, retryable: false });
  assert.equal(error.code, "unauthorized"); assert.equal(error.status, 401); assert.equal(error.retryable, false);
  assert(!JSON.stringify(error).includes("bearer"));
  assert.match(formatDiagnostic(error), /health.*https:\/\/e\.test.*401/);
});

test("unknown errors use operation-sensitive safe codes", () => {
  assert.equal(asAgentmemoryError(new Error("secret body"), "startup", "http://x").code, "startup_failed");
  const e = asAgentmemoryError(new Error("secret body"), "search", "http://x");
  assert.equal(e.code, "invalid_response");
  assert(!e.message.includes("secret body"));
  assert.equal(e.cause, undefined);
});
