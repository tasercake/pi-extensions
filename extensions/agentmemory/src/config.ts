import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentmemoryError } from "./errors.js";

export const DEFAULT_BASE_URL = "http://localhost:3111";
export const REQUEST_TIMEOUT_MS = 2_000;
export const LIVENESS_TIMEOUT_MS = 1_000;
export const RECALL_TIMEOUT_MS = 1_500;
export const STARTUP_TIMEOUT_MS = 45_000;
export const STARTUP_POLL_MS = 250;
export const LOCK_STALE_MS = 60_000;
export const RUNTIME_HUNG_MS = 5 * 60_000;
export const SHUTDOWN_DRAIN_MS = 2_000;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 24 * 1024;
export const MAX_TOOL_OUTPUT_LINES = 200;
export const MAX_RECALL_RESULTS = 5;
export const MAX_RECALL_TOKEN_BUDGET = 1_200;
export const MAX_RECALL_CHARS = 12_000;
export const MAX_QUERY_CHARS = 2_000;
export const MAX_SAVE_CHARS = 8_000;
export const MAX_CAPTURE_PROMPT_CHARS = 2_000;
export const MAX_CAPTURE_RESPONSE_CHARS = 8_000;
export const MAX_CAPTURE_QUEUE = 20;
export const CAPTURE_ATTEMPTS = 3;
export const CAPTURE_RETRY_DELAYS_MS = [250, 1_000] as const;
export const MAX_LOG_BYTES = 1 * 1024 * 1024;
export const MAX_LOG_LINE_BYTES = 8 * 1024;

export interface AgentmemoryConfig {
  baseUrl: string;
  parsedUrl: URL;
  secret?: string;
  allowInsecureHttp: boolean;
  autostart: boolean;
  autoRecall: boolean;
  autoCapture: boolean;
  canAutostart: boolean;
  endpointHash: string;
  stateDir: string;
  logPath: string;
}
export type ConfigResult = { ok: true; config: AgentmemoryConfig } | { ok: false; error: AgentmemoryError };

type Env = Record<string, string | undefined>;

function invalid(reason: string, endpoint = "invalid AGENTMEMORY_URL"): ConfigResult {
  return { ok: false, error: new AgentmemoryError("invalid_config", `Invalid Agentmemory configuration for ${endpoint}: ${reason}`, { endpoint, operation: "configuration", reason }) };
}

function parseBoolean(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  switch (raw.toLowerCase()) {
    case "1": case "true": return true;
    case "0": case "false": return false;
    default: throw new Error(`${key} must be one of 1, true, 0, or false`);
  }
}

export function isExactLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function enforceTransportPolicy(url: URL, secret: string | undefined, allowInsecureHttp: boolean, requireHttps = false): void {
  if (!secret) return;
  if (url.protocol === "https:") return;
  if (!requireHttps && isExactLoopback(url)) return;
  if (!requireHttps && allowInsecureHttp) return;
  throw new AgentmemoryError("insecure_transport", `Refusing to send Agentmemory credentials over insecure transport to ${url.origin}`, { endpoint: url.origin, operation: "configuration", reason: "bearer token over non-loopback HTTP is disabled" });
}

export function loadConfig(env: Env = process.env, home = homedir()): ConfigResult {
  const rawUrl = env.AGENTMEMORY_URL ?? DEFAULT_BASE_URL;
  let parsedUrl: URL;
  try { parsedUrl = new URL(rawUrl); } catch { return invalid("AGENTMEMORY_URL is not a valid URL"); }
  const safeEndpoint = parsedUrl.origin === "null" ? "invalid AGENTMEMORY_URL" : parsedUrl.origin;
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return invalid("only http: and https: are supported", safeEndpoint);
  if (parsedUrl.username || parsedUrl.password) return invalid("URL credentials are not allowed", safeEndpoint);
  if (parsedUrl.search) return invalid("URL query is not allowed", safeEndpoint);
  if (parsedUrl.hash) return invalid("URL fragment is not allowed", safeEndpoint);
  // WHATWG URL resolution can erase encoded dot segments. Accept only an empty or literal root suffix.
  const authorityEnd = rawUrl.indexOf("//") + 2;
  const suffixIndex = rawUrl.slice(authorityEnd).search(/[/?#]/);
  const suffix = suffixIndex < 0 ? "" : rawUrl.slice(authorityEnd + suffixIndex);
  if (parsedUrl.pathname !== "/" || (suffix !== "" && suffix !== "/")) return invalid("URL path must be the literal root path", safeEndpoint);

  let autostart: boolean, autoRecall: boolean, autoCapture: boolean, allowInsecureHttp: boolean, requireHttps: boolean;
  try {
    autostart = parseBoolean(env, "PI_AGENTMEMORY_AUTOSTART", true);
    autoRecall = parseBoolean(env, "PI_AGENTMEMORY_AUTO_RECALL", true);
    autoCapture = parseBoolean(env, "PI_AGENTMEMORY_AUTO_CAPTURE", true);
    allowInsecureHttp = parseBoolean(env, "PI_AGENTMEMORY_ALLOW_INSECURE_HTTP", false);
    requireHttps = parseBoolean(env, "AGENTMEMORY_REQUIRE_HTTPS", false);
  } catch (error) { return invalid((error as Error).message, safeEndpoint); }

  const secret = env.AGENTMEMORY_SECRET || undefined;
  try { enforceTransportPolicy(parsedUrl, secret, allowInsecureHttp, requireHttps); }
  catch (error) { return { ok: false, error: error as AgentmemoryError }; }

  const baseUrl = parsedUrl.origin;
  const endpointHash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
  const stateDir = join(home, ".agentmemory", "pi-extension", endpointHash);
  return { ok: true, config: {
    baseUrl, parsedUrl: new URL(baseUrl), ...(secret ? { secret } : {}), allowInsecureHttp,
    autostart, autoRecall, autoCapture,
    canAutostart: autostart && parsedUrl.protocol === "http:" && isExactLoopback(parsedUrl),
    endpointHash, stateDir, logPath: join(stateDir, "agentmemory.log"),
  } };
}
