import test from "node:test";
import assert from "node:assert/strict";
import { AgentmemoryClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { AgentmemoryError } from "../src/errors.js";
import { startHttpServer, type Reply } from "./support/http-server.js";

function client(baseUrl: string, secret = "shh", options: ConstructorParameters<typeof AgentmemoryClient>[1] = {}) {
  const result = loadConfig({ AGENTMEMORY_URL: baseUrl, AGENTMEMORY_SECRET: secret }, "/h");
  assert(result.ok);
  return new AgentmemoryClient(result.config, options);
}

const live = { service: "agentmemory", status: "ok" };
const healthy = { service: "agentmemory", status: "healthy", version: "0.9.27" };

test("healthy probe validates identity and authenticates only health", async () => {
  const server = await startHttpServer((r) => ({ body: r.path.endsWith("livez") ? live : healthy }));
  try {
    assert.deepEqual(await client(server.baseUrl).probe(), { kind: "healthy", version: "0.9.27" });
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0]!.headers.authorization, undefined);
    assert.equal(server.requests[1]!.headers.authorization, "Bearer shh");
  } finally { await server.close(); }
});

test("probe distinguishes unavailable unauthorized foreign and unhealthy", async (t) => {
  const cases: Array<[string, (path: string) => Reply, string]> = [
    ["401", (p) => ({ status: p.endsWith("livez") ? 200 : 401, body: p.endsWith("livez") ? live : { error: "secret-body" } }), "unauthorized"],
    ["403", (p) => ({ status: p.endsWith("livez") ? 200 : 403, body: p.endsWith("livez") ? live : {} }), "unauthorized"],
    ["wrong service", () => ({ body: { service: "other", status: "ok" } }), "foreign"],
    ["degraded", (p) => ({ body: p.endsWith("livez") ? live : { service: "agentmemory", status: "degraded" } }), "unhealthy"],
    ["critical 503", (p) => ({ status: p.endsWith("livez") ? 200 : 503, body: p.endsWith("livez") ? live : { service: "agentmemory", status: "critical" } }), "unhealthy"],
    ["malformed", () => ({ raw: "{" }), "foreign"],
  ];
  for (const [name, replies, expected] of cases) await t.test(name, async () => {
    const server = await startHttpServer((r) => replies(r.path));
    try { assert.equal((await client(server.baseUrl).probe()).kind, expected); } finally { await server.close(); }
  });
  const portServer = await startHttpServer(() => ({ body: live })); const url = portServer.baseUrl; await portServer.close();
  const result = await client(url, "").probe(); assert.equal(result.kind, "unreachable");
});

test("deadlines caller abort HTTP errors and diagnostics are safe", async () => {
  const server = await startHttpServer(() => ({ delayMs: 100, body: live }));
  try {
    const timed = await client(server.baseUrl, "", { requestTimeoutMs: 20, livenessTimeoutMs: 20 }).probe();
    assert.equal(timed.kind, "unreachable");
    if (timed.kind === "unreachable") { assert.equal(timed.error.code, "timeout"); assert(timed.error.message.includes(server.baseUrl)); }
    const controller = new AbortController(); controller.abort();
    const aborted = await client(server.baseUrl, "").probe(controller.signal);
    assert.equal(aborted.kind, "unreachable"); if (aborted.kind === "unreachable") assert.equal(aborted.error.code, "aborted");
  } finally { await server.close(); }
  for (const status of [404, 500]) {
    const bad = await startHttpServer(() => ({ status, body: { secret: "LEAK-ME" } }));
    try { const out = await client(bad.baseUrl, "bearer-value").probe(); assert.equal(out.kind, "foreign"); assert(!JSON.stringify(out).includes("LEAK-ME")); assert(!JSON.stringify(out).includes("bearer-value")); } finally { await bad.close(); }
  }
});

test("deadline and caller abort remain classified while reading response streams", async () => {
  const hangingFetch = async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); } }));
  const timed = await client("http://localhost:3111", "", { fetch: hangingFetch as typeof globalThis.fetch, livenessTimeoutMs: 10 }).probe();
  assert.equal(timed.kind, "unreachable"); if (timed.kind === "unreachable") assert.equal(timed.error.code, "timeout");
  const controller = new AbortController(); const pending = client("http://localhost:3111", "", { fetch: hangingFetch as typeof globalThis.fetch }).probe(controller.signal); setTimeout(() => controller.abort(), 5);
  const aborted = await pending; assert.equal(aborted.kind, "unreachable"); if (aborted.kind === "unreachable") assert.equal(aborted.error.code, "aborted");
});

test("bounded reader rejects declared and streamed oversized bodies and cancels", async () => {
  for (const reply of [{ headers: { "content-length": "999999" }, body: live }, { chunks: ["x".repeat(300000), "x".repeat(300000)] }]) {
    const server = await startHttpServer(() => reply);
    try {
      const result = await client(server.baseUrl, "").probe(); assert.equal(result.kind, "foreign");
      if (result.kind === "foreign") assert.equal(result.error.code, "response_too_large");
    } finally { await server.close(); }
  }
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(300000)); }, cancel() { cancelled = true; } });
  const fetch = async () => new Response(stream);
  const result = await client("http://localhost:3111", "", { fetch: fetch as typeof globalThis.fetch }).probe();
  assert.equal(result.kind, "foreign"); assert(cancelled);
});

test("narrative search sends one exact request and normalizes bounded hits", async () => {
  const huge = "x".repeat(3000);
  const server = await startHttpServer(() => ({ body: { results: [
    { obsId: "o", sessionId: "s", title: huge, narrative: huge, score: 0.5, timestamp: "now" },
    { title: 3, narrative: "bad" }, { title: "ok", narrative: "yes" }, { title: "extra", narrative: "no" },
  ], truncated: true, tokens_used: 99 } }));
  try {
    const result = await client(server.baseUrl).search({ query: "q", limit: 2, project: "/p", cwd: "/p", tokenBudget: 1200 });
    assert.equal(server.requests.length, 1); assert.equal(server.requests[0]!.path, "/agentmemory/search");
    assert.deepEqual(server.requests[0]!.body, { query: "q", limit: 2, project: "/p", cwd: "/p", format: "narrative", token_budget: 1200 });
    assert.equal(result.hits.length, 2); assert.equal(result.hits[0]!.title.length, 200); assert.equal(result.hits[0]!.narrative.length, 2000);
    assert.equal(result.truncated, true); assert.equal(result.tokensUsed, 99);
  } finally { await server.close(); }
});

test("malformed 5xx API responses remain retryable HTTP errors",async()=>{const server=await startHttpServer(()=>({status:500,raw:"{"}));try{await assert.rejects(()=>client(server.baseUrl).remember({content:"c",type:"fact"}),(error:any)=>error instanceof AgentmemoryError&&error.code==="http_error"&&error.status===500&&error.retryable);}finally{await server.close();}});

test("remember and observe enforce exact successful schemas", async () => {
  const replies: Reply[] = [
    { status: 201, body: { success: true, memory: { id: "m", type: "fact", title: "T" } } },
    { status: 201, body: { success: true } },
    { status: 201, body: { deduplicated: true } },
  ];
  const server = await startHttpServer(() => replies.shift()!);
  try {
    assert.deepEqual(await client(server.baseUrl).remember({ content: "c", type: "fact", project: "/p" }), { memoryId: "m", type: "fact", title: "T" });
    await client(server.baseUrl).observe({ hello: "world" }); await client(server.baseUrl).observe({ hello: "world" });
  } finally { await server.close(); }
  for (const [method, response] of [["remember", { status: 200, body: { success: true } }], ["remember", { status: 201, body: { success: false } }], ["observe", { status: 201, body: { success: false } }]] as const) {
    const bad = await startHttpServer(() => response);
    try { await assert.rejects(() => method === "remember" ? client(bad.baseUrl).remember({ content: "c", type: "fact" }) : client(bad.baseUrl).observe({}), AgentmemoryError); } finally { await bad.close(); }
  }
});
