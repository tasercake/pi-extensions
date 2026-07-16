import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, isExactLoopback, enforceTransportPolicy, DEFAULT_BASE_URL } from "../src/config.js";

test("default canonical URL and hash stability", () => {
  const a = loadConfig({}, "/tmp/home");
  const b = loadConfig({ AGENTMEMORY_URL: "http://localhost:3111/" }, "/tmp/home");
  assert(a.ok && b.ok);
  assert.equal(a.config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(a.config.endpointHash, b.config.endpointHash);
  assert.match(a.config.endpointHash, /^[0-9a-f]{16}$/);
  assert.equal(a.config.stateDir, `/tmp/home/.agentmemory/pi-extension/${a.config.endpointHash}`);
});

test("exact loopback classification and strict URL validation", () => {
  for (const url of ["http://localhost:1", "http://127.0.0.1:1", "http://[::1]:1"]) {
    const result = loadConfig({ AGENTMEMORY_URL: url }, "/h");
    assert(result.ok && isExactLoopback(result.config.parsedUrl));
  }
  for (const url of ["http://localhost.:1", "http://0.0.0.0:1", "http://127.0.0.2:1"]) {
    const result = loadConfig({ AGENTMEMORY_URL: url }, "/h");
    assert(result.ok && !isExactLoopback(result.config.parsedUrl));
  }
  for (const url of ["http://u:p@localhost:1", "http://localhost:1/?q=x", "http://localhost:1/#x", "ftp://localhost/", "http://localhost/a", "http://localhost/%2e"]) {
    const result = loadConfig({ AGENTMEMORY_URL: url }, "/h");
    assert.equal(result.ok, false, url);
  }
});

test("boolean spellings are exact and malformed values fail", () => {
  for (const yes of ["1", "true", "TRUE"]) assert.equal(loadConfig({ PI_AGENTMEMORY_AUTOSTART: yes }, "/h").ok, true);
  for (const no of ["0", "false", "FALSE"]) {
    const result = loadConfig({ PI_AGENTMEMORY_AUTOSTART: no }, "/h");
    assert(result.ok && !result.config.autostart);
  }
  for (const bad of ["", "yes", "2", " true "]) assert.equal(loadConfig({ PI_AGENTMEMORY_AUTOSTART: bad }, "/h").ok, false);
});

test("secret transport policy is fail closed", () => {
  assert(loadConfig({ AGENTMEMORY_SECRET: "s" }, "/h").ok);
  assert(loadConfig({ AGENTMEMORY_URL: "https://example.test", AGENTMEMORY_SECRET: "s" }, "/h").ok);
  const remote = loadConfig({ AGENTMEMORY_URL: "http://example.test", AGENTMEMORY_SECRET: "s" }, "/h");
  assert.equal(remote.ok, false);
  const override = loadConfig({ AGENTMEMORY_URL: "http://example.test", AGENTMEMORY_SECRET: "s", PI_AGENTMEMORY_ALLOW_INSECURE_HTTP: "true" }, "/h");
  assert(override.ok && override.config.allowInsecureHttp && !override.config.canAutostart);
  assert.equal(loadConfig({ AGENTMEMORY_URL: "http://example.test", AGENTMEMORY_SECRET: "s", AGENTMEMORY_REQUIRE_HTTPS: "false" }, "/h").ok, false);
});

test("invalid URL diagnostics redact credentials query secrets and malformed input", () => {
  for (const raw of ["http://alice:SUPERSECRET@localhost:3111", "http://localhost:3111/?token=SUPERSECRET", "not-a-url-SUPERSECRET"]) {
    const result = loadConfig({ AGENTMEMORY_URL: raw }, "/h"); assert.equal(result.ok, false);
    if (!result.ok) { assert(!result.error.message.includes("SUPERSECRET")); assert(!JSON.stringify(result.error.diagnostic).includes("SUPERSECRET")); }
  }
});

test("transport helper rejects before network and paths contain no secret", () => {
  assert.throws(() => enforceTransportPolicy(new URL("http://example.test"), "top-secret", false));
  const result = loadConfig({ AGENTMEMORY_SECRET: "top-secret" }, "/injected");
  assert(result.ok);
  assert(!result.config.stateDir.includes("top-secret"));
  assert(!result.config.stateDir.includes("@"));
});
