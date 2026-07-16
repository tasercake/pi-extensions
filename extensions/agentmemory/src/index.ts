import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentmemoryExtension } from "./extension.js";

export default function agentmemoryExtension(pi: ExtensionAPI): void {
  registerAgentmemoryExtension(pi);
}

export { AgentmemoryClient } from "./client.js";
export { CaptureQueue, buildObservePayload, createCaptureItem, findPendingTurns, getText } from "./capture.js";
export { loadConfig } from "./config.js";
export { DaemonManager } from "./daemon.js";
export { AgentmemoryError } from "./errors.js";
export { boundToolOutput, registerAgentmemoryExtension } from "./extension.js";
