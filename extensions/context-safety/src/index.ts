import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const TOOL_TEXT_LIMIT_BYTES = 32 * 1024;
const TOOL_DETAILS_LIMIT_BYTES = 32 * 1024;
const AT_FILE_LIMIT_BYTES = 16 * 1024;
const MESSAGE_LIMIT_BYTES = 64 * 1024;
const SPILL_SCHEMA_VERSION = 1;

type SpillKind = "tool_result" | "at_file" | "overflow_message";

type JsonRecord = Record<string, unknown>;

type AtToken = {
  start: number;
  end: number;
  rawPath: string;
};

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
    return `[${typeof value}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
    const out: JsonRecord = {};
    for (const [k, v] of Object.entries(value as JsonRecord)) out[k] = toJsonSafe(v, seen);
    return out;
  }
  return String(value);
}

function safeJson(value: unknown): string {
  return JSON.stringify(toJsonSafe(value)) ?? "null";
}

function safeId(value: unknown): string {
  const raw = safeString(value).trim();
  const compact = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (compact || "unknown").slice(0, 80);
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function getSessionId(ctx: ExtensionContext): string {
  try {
    const id = ctx.sessionManager.getSessionId();
    return safeId(id || "default");
  } catch {
    return "default";
  }
}

function spillDir(ctx: ExtensionContext): string {
  return join(getAgentDir(), "spills", "context-safety", getSessionId(ctx));
}

function writePrivateJson(path: string, data: unknown): void {
  const payload = `${JSON.stringify(toJsonSafe(data), null, 2)}\n`;
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, payload, 0, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writeSpill(ctx: ExtensionContext, kind: SpillKind, id: unknown, payload: JsonRecord): string {
  const dir = spillDir(ctx);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `${timestampForFile()}-${kind}-${safeId(id)}.json`;
  let path = join(dir, base);
  for (let i = 1; existsSync(path); i += 1) {
    path = join(dir, `${timestampForFile()}-${kind}-${safeId(id)}-${i}.json`);
  }
  writePrivateJson(path, {
    schemaVersion: SPILL_SCHEMA_VERSION,
    kind,
    createdAt: new Date().toISOString(),
    cwd: ctx.cwd,
    sessionId: getSessionId(ctx),
    ...payload,
  });
  return path;
}

function textBlocks(content: (TextContent | ImageContent)[]): string[] {
  return content.filter((block): block is TextContent => block.type === "text").map((block) => block.text);
}

function toolNotice(toolName: string, originalBytes: number, spillPath: string): string {
  return `Tool result exceeded context safety limit and was not inserted into context.\n\nTool: ${toolName}\nOriginal size: ${originalBytes} bytes\nFull result saved to: ${spillPath}\n\nUse targeted reads/searches against this file instead of loading it wholesale.`;
}

function messageNotice(originalBytes: number, spillPath: string): string {
  return `Message removed from model context/history because it exceeded context safety limit.\n\nOriginal size: ${originalBytes} bytes\nFull message saved to: ${spillPath}`;
}

function replacementMessage(message: AgentMessage, notice: string): AgentMessage {
  const role = (message as { role?: unknown }).role;
  if (role === "user") {
    const original = message as Extract<AgentMessage, { role: "user" }>;
    return { role: "user", content: notice, timestamp: original.timestamp } as AgentMessage;
  }
  if (role === "toolResult") {
    const original = message as Extract<AgentMessage, { role: "toolResult" }>;
    return {
      role: "toolResult",
      toolCallId: original.toolCallId,
      toolName: original.toolName,
      content: [{ type: "text", text: notice }],
      isError: original.isError,
      timestamp: original.timestamp,
    } as AgentMessage;
  }
  if (role === "assistant") {
    const original = message as Extract<AgentMessage, { role: "assistant" }>;
    return {
      role: "assistant",
      content: [{ type: "text", text: notice }],
      api: original.api,
      provider: original.provider,
      model: original.model,
      responseModel: original.responseModel,
      usage: original.usage,
      stopReason: original.stopReason,
      timestamp: original.timestamp,
    } as AgentMessage;
  }
  return { ...(message as AgentMessage), content: [{ type: "text", text: notice }] } as AgentMessage;
}

function resolveInputPath(rawPath: string, cwd: string): string {
  const expanded = rawPath === "~" ? homedir() : rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function isTokenBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s|[([{<]/.test(ch);
}

function parseAtFileTokens(text: string): AtToken[] {
  const tokens: AtToken[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "@" || !isTokenBoundary(text[i - 1])) continue;
    const pathStart = i + 1;
    if (pathStart >= text.length) continue;
    const quote = text[pathStart];
    if (quote === '"' || quote === "'" || quote === "`") {
      let rawPath = "";
      let j = pathStart + 1;
      for (; j < text.length; j += 1) {
        const ch = text[j];
        if (ch === "\\" && j + 1 < text.length) {
          rawPath += text[j + 1];
          j += 1;
          continue;
        }
        if (ch === quote) break;
        rawPath += ch;
      }
      if (j < text.length && rawPath.length > 0) {
        tokens.push({ start: i, end: j + 1, rawPath });
        i = j;
      }
      continue;
    }
    let j = pathStart;
    while (j < text.length && !/\s/.test(text[j])) j += 1;
    const rawPath = text.slice(pathStart, j).replace(/[),.;:!?]+$/u, "");
    if (rawPath.length === 0) continue;
    tokens.push({ start: i, end: pathStart + rawPath.length, rawPath });
    i = j - 1;
  }
  return tokens;
}

function maybeOversizedRegularFile(path: string): number | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return stat.size;
  } catch {
    return undefined;
  }
}

function messageContextBytes(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return utf8Bytes(content);
  if (!Array.isArray(content)) return utf8Bytes(safeJson(message));

  let bytes = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      bytes += utf8Bytes(safeString(block));
      continue;
    }
    const typed = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (typed.type === "image") continue;
    if (typeof typed.text === "string") {
      bytes += utf8Bytes(typed.text);
      continue;
    }
    if (typeof typed.thinking === "string") {
      bytes += utf8Bytes(typed.thinking);
      continue;
    }
    bytes += utf8Bytes(safeJson(block));
  }
  return bytes;
}

function quarantineMessage(message: AgentMessage, ctx: ExtensionContext, id: unknown): AgentMessage | undefined {
  const originalBytes = messageContextBytes(message);
  if (originalBytes <= MESSAGE_LIMIT_BYTES) return undefined;
  const spillPath = writeSpill(ctx, "overflow_message", id, {
    input: { source: "message" },
    content: message,
    originalBytes,
  });
  return replacementMessage(message, messageNotice(originalBytes, spillPath));
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    const textBytes = utf8Bytes(textBlocks(event.content).join("\n"));
    const detailsJson = safeJson(event.details);
    const detailsBytes = utf8Bytes(detailsJson);
    if (textBytes <= TOOL_TEXT_LIMIT_BYTES && detailsBytes <= TOOL_DETAILS_LIMIT_BYTES) return;

    const originalBytes = Math.max(textBytes, detailsBytes);
    const spillPath = writeSpill(ctx, "tool_result", `${event.toolName}-${event.toolCallId}`, {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      content: event.content,
      details: event.details,
      isError: event.isError,
      originalBytes,
    });
    return {
      content: [{ type: "text", text: toolNotice(event.toolName, originalBytes, spillPath) }],
      details: {
        contextSafetySpilled: true,
        spillPath,
        originalBytes,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      },
      isError: event.isError,
    };
  });

  pi.on("input", async (event, ctx) => {
    const tokens = parseAtFileTokens(event.text);
    if (tokens.length === 0) return;

    const rewrites = [] as Array<AtToken & { absPath: string; size: number }>;
    for (const token of tokens) {
      const absPath = resolveInputPath(token.rawPath, ctx.cwd);
      const size = maybeOversizedRegularFile(absPath);
      if (size !== undefined && size > AT_FILE_LIMIT_BYTES) rewrites.push({ ...token, absPath, size });
    }
    if (rewrites.length === 0) return;

    let rewrittenText = "";
    let cursor = 0;
    const notices: string[] = [];
    for (const rewrite of rewrites) {
      rewrittenText += event.text.slice(cursor, rewrite.start);
      rewrittenText += rewrite.absPath;
      cursor = rewrite.end;
      const spillPath = writeSpill(ctx, "at_file", rewrite.absPath, {
        input: { token: event.text.slice(rewrite.start, rewrite.end), path: rewrite.absPath, size: rewrite.size },
        content: { path: rewrite.absPath },
        originalBytes: rewrite.size,
      });
      notices.push(`[Context safety: ${rewrite.absPath} is ${rewrite.size} bytes, above the 16 KiB @file inline limit. It was not inlined. Spill metadata saved to: ${spillPath}. Use read with offset/limit, rg, head, tail, jq, or targeted parsing.]`);
    }
    rewrittenText += event.text.slice(cursor);
    rewrittenText = `${rewrittenText}\n\n${notices.join("\n")}`;
    return { action: "transform", text: rewrittenText, images: event.images };
  });

  pi.on("message_end", async (event, ctx) => {
    const replacement = quarantineMessage(event.message, ctx, "message-end");
    if (!replacement) return;
    return { message: replacement };
  });

  pi.on("context", async (event, ctx) => {
    let changed = false;
    const messages = event.messages.map((message, index) => {
      const replacement = quarantineMessage(message, ctx, `context-${index}`);
      if (!replacement) return message;
      changed = true;
      return replacement;
    });
    if (!changed) return;
    return { messages };
  });
}
