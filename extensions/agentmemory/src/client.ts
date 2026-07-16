import type { AgentmemoryConfig } from "./config.js";
import { LIVENESS_TIMEOUT_MS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from "./config.js";
import { AgentmemoryError, asAgentmemoryError } from "./errors.js";

export interface HealthyProbe { kind: "healthy"; version?: string }
export type ProbeResult =
  | HealthyProbe
  | { kind: "unreachable"; error: AgentmemoryError }
  | { kind: "unauthorized"; error: AgentmemoryError }
  | { kind: "unhealthy"; status: string; error: AgentmemoryError }
  | { kind: "foreign"; error: AgentmemoryError };
export interface SearchHit { obsId?: string; sessionId?: string; title: string; narrative: string; score?: number; timestamp?: string }
export interface SearchResult { hits: SearchHit[]; truncated: boolean; tokensUsed?: number }
export interface RememberResult { memoryId?: string; type: string; title?: string }

export interface ClientOptions {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  livenessTimeoutMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

export class AgentmemoryClient {
  readonly config: AgentmemoryConfig;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;

  constructor(config: AgentmemoryConfig, options: ClientOptions = {}) {
    this.config = config;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.livenessTimeoutMs = options.livenessTimeoutMs ?? LIVENESS_TIMEOUT_MS;
    this.setTimer = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    let liveness: { response: Response; json: unknown };
    try { liveness = await this.request("liveness", "/agentmemory/livez", { method: "GET" }, signal, this.livenessTimeoutMs, false); }
    catch (error) {
      const typed = error instanceof AgentmemoryError ? error : asAgentmemoryError(error, "liveness", this.config.baseUrl);
      if (["unreachable", "timeout", "aborted"].includes(typed.code)) return { kind: "unreachable", error: typed };
      return { kind: "foreign", error: typed };
    }
    if (liveness.response.status !== 200 || !isObject(liveness.json) || liveness.json.service !== "agentmemory" || liveness.json.status !== "ok") {
      return { kind: "foreign", error: this.error("foreign_service", "liveness", "listener is not a healthy Agentmemory service", liveness.response.status) };
    }

    let health: { response: Response; json: unknown };
    try { health = await this.request("health", "/agentmemory/health", { method: "GET" }, signal, this.requestTimeoutMs, true); }
    catch (error) {
      const typed = error instanceof AgentmemoryError ? error : asAgentmemoryError(error, "health", this.config.baseUrl);
      if (typed.code === "unauthorized") return { kind: "unauthorized", error: typed };
      if (["unreachable", "timeout", "aborted"].includes(typed.code)) return { kind: "unreachable", error: typed };
      return { kind: "foreign", error: typed };
    }
    if (!isObject(health.json) || health.json.service !== "agentmemory") {
      return { kind: "foreign", error: this.error("foreign_service", "health", "listener returned a foreign health response", health.response.status) };
    }
    const status = typeof health.json.status === "string" ? health.json.status : "invalid";
    if (health.response.status === 401 || health.response.status === 403) return { kind: "unauthorized", error: this.error("unauthorized", "health", "authorization rejected", health.response.status) };
    if (status !== "healthy") return { kind: "unhealthy", status, error: this.error("unhealthy", "health", `Agentmemory status is ${status}`, health.response.status) };
    if (health.response.status !== 200) return { kind: "foreign", error: this.error("http_error", "health", "unexpected health status", health.response.status) };
    return { kind: "healthy", ...(typeof health.json.version === "string" ? { version: health.json.version.slice(0, 100) } : {}) };
  }

  async search(input: { query: string; limit: number; project?: string; cwd?: string; tokenBudget: number }, signal?: AbortSignal): Promise<SearchResult> {
    const body = { query: input.query, limit: input.limit, ...(input.project === undefined ? {} : { project: input.project }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }), format: "narrative", token_budget: input.tokenBudget };
    const { response, json } = await this.request("search", "/agentmemory/search", this.jsonInit("POST", body), signal, this.requestTimeoutMs, true);
    this.requireStatus(response, json, "search", 200);
    if (!isObject(json) || !Array.isArray(json.results)) throw this.error("invalid_response", "search", "invalid search response", response.status);
    const hits: SearchHit[] = [];
    for (const value of json.results.slice(0, 100)) {
      if (hits.length >= input.limit) break;
      if (!isObject(value) || typeof value.title !== "string" || typeof value.narrative !== "string") continue;
      hits.push({
        ...(typeof value.obsId === "string" ? { obsId: value.obsId.slice(0, 500) } : {}),
        ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId.slice(0, 500) } : {}),
        title: value.title.slice(0, 200), narrative: value.narrative.slice(0, 2_000),
        ...(typeof value.score === "number" && Number.isFinite(value.score) ? { score: value.score } : {}),
        ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp.slice(0, 100) } : {}),
      });
    }
    return { hits, truncated: json.truncated === true || json.results.length > input.limit, ...(typeof json.tokens_used === "number" && Number.isFinite(json.tokens_used) ? { tokensUsed: json.tokens_used } : {}) };
  }

  async remember(input: { content: string; type: string; project?: string }, signal?: AbortSignal): Promise<RememberResult> {
    const { response, json } = await this.request("remember", "/agentmemory/remember", this.jsonInit("POST", input), signal, this.requestTimeoutMs, true);
    if (response.status !== 201) { this.requireStatus(response, json, "remember", 201); }
    if (!isObject(json) || json.success !== true) throw this.error("invalid_response", "remember", "invalid remember response", response.status);
    const memory = json.memory;
    if (memory !== undefined && (!isObject(memory) || (memory.id !== undefined && typeof memory.id !== "string") || (memory.type !== undefined && typeof memory.type !== "string") || (memory.title !== undefined && typeof memory.title !== "string"))) throw this.error("invalid_response", "remember", "invalid memory record", response.status);
    const record = isObject(memory) ? memory : {};
    return { ...(typeof record.id === "string" ? { memoryId: record.id.slice(0, 500) } : {}), type: typeof record.type === "string" ? record.type.slice(0, 100) : input.type, ...(typeof record.title === "string" ? { title: record.title.slice(0, 200) } : {}) };
  }

  async observe(payload: unknown, signal?: AbortSignal): Promise<void> {
    const { response, json } = await this.request("observe", "/agentmemory/observe", this.jsonInit("POST", payload), signal, this.requestTimeoutMs, true);
    if (response.status !== 201) { this.requireStatus(response, json, "observe", 201); }
    if (!isObject(json) || (json.success === false && json.deduplicated !== true)) throw this.error("invalid_response", "observe", "invalid observe response", response.status);
  }

  private jsonInit(method: string, body: unknown): RequestInit { return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }

  private async request(operation: string, path: string, init: RequestInit, callerSignal: AbortSignal | undefined, timeoutMs: number, authenticate: boolean): Promise<{ response: Response; json: unknown }> {
    if (callerSignal?.aborted) throw this.error("aborted", operation, "request aborted by caller");
    const controller = new AbortController(); let deadline = false;
    const abort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", abort, { once: true });
    const timer = this.setTimer(() => { deadline = true; controller.abort(); }, timeoutMs);
    const headers = new Headers(init.headers);
    if (authenticate && this.config.secret) headers.set("authorization", `Bearer ${this.config.secret}`);
    try {
      let response: Response;
      try { response = await this.fetchFn(`${this.config.baseUrl}${path}`, { ...init, headers, signal: controller.signal }); }
      catch (error) {
        if (callerSignal?.aborted) throw this.error("aborted", operation, "request aborted by caller");
        if (deadline) throw this.error("timeout", operation, "request deadline exceeded", undefined, true);
        throw this.error("unreachable", operation, "endpoint could not be reached", undefined, true, error);
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw this.error("unauthorized", operation, "authorization rejected", response.status);
      }
      let json: unknown;
      try { json = await this.readJson(response, operation); }
      catch (error) {
        if (callerSignal?.aborted) throw this.error("aborted", operation, "request aborted by caller");
        if (deadline) throw this.error("timeout", operation, "request deadline exceeded", undefined, true);
        if (response.status >= 400 && error instanceof AgentmemoryError && error.code === "invalid_response") throw this.error("http_error", operation, `unexpected HTTP status ${response.status}`, response.status, response.status >= 500);
        throw error;
      }
      return { response, json };
    } finally { this.clearTimer(timer); callerSignal?.removeEventListener("abort", abort); }
  }

  private async readJson(response: Response, operation: string): Promise<unknown> {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw this.error("response_too_large", operation, "response exceeds size limit", response.status); }
    if (!response.body) return undefined;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw this.error("response_too_large", operation, "response exceeds size limit", response.status); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw this.error("invalid_response", operation, "response is not valid JSON", response.status); }
  }

  private requireStatus(response: Response, _json: unknown, operation: string, expected: number): void {
    if (response.status === expected) return;
    throw this.error(response.status === 401 || response.status === 403 ? "unauthorized" : "http_error", operation, `unexpected HTTP status ${response.status}`, response.status, response.status >= 500);
  }

  private error(code: AgentmemoryError["code"], operation: string, reason: string, status?: number, retryable = false, cause?: unknown): AgentmemoryError {
    return new AgentmemoryError(code, `${operation} failed for ${this.config.baseUrl}: ${reason}`, { endpoint: this.config.baseUrl, operation, ...(status === undefined ? {} : { status }), reason }, { status, retryable, cause });
  }
}
