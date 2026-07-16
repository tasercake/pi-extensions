import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown; rawBody: string }
export interface Reply { status?: number; headers?: Record<string, string>; body?: unknown; raw?: string; delayMs?: number; chunks?: string[] }

export async function startHttpServer(handler: (request: RecordedRequest) => Reply | Promise<Reply>) {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk.toString();
    let body: unknown;
    try { body = rawBody ? JSON.parse(rawBody) : undefined; } catch { body = rawBody; }
    const record = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, rawBody };
    requests.push(record);
    const reply = await handler(record);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
    if (reply.chunks) for (const chunk of reply.chunks) res.write(chunk);
    res.end(reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
