export type AgentmemoryErrorCode =
  | "invalid_config" | "insecure_transport" | "unreachable" | "timeout" | "aborted"
  | "http_error" | "unauthorized" | "invalid_response" | "response_too_large"
  | "unhealthy" | "foreign_service" | "startup_busy" | "startup_failed";

export interface SafeDiagnostic {
  endpoint: string;
  operation: string;
  status?: number;
  reason: string;
}

export class AgentmemoryError extends Error {
  readonly code: AgentmemoryErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly diagnostic: Readonly<SafeDiagnostic>;

  constructor(
    code: AgentmemoryErrorCode,
    message: string,
    diagnostic: SafeDiagnostic,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    // Unknown causes can retain response bodies, headers, or secrets; keep only the safe diagnostic.
    super(message);
    this.name = "AgentmemoryError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.diagnostic = Object.freeze({
      endpoint: diagnostic.endpoint,
      operation: diagnostic.operation,
      ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
      reason: diagnostic.reason,
    });
  }
}

export function asAgentmemoryError(error: unknown, operation: string, endpoint: string): AgentmemoryError {
  if (error instanceof AgentmemoryError) return error;
  const code: AgentmemoryErrorCode = operation.startsWith("startup") ? "startup_failed" : "invalid_response";
  return new AgentmemoryError(
    code,
    `${operation} failed for ${endpoint}`,
    { endpoint, operation, reason: code },
    { cause: error },
  );
}

export function formatDiagnostic(error: unknown): string {
  if (!(error instanceof AgentmemoryError)) return "Agentmemory operation failed";
  const { operation, endpoint, status, reason } = error.diagnostic;
  return `${operation} at ${endpoint} failed${status === undefined ? "" : ` (HTTP ${status})`}: ${reason}`;
}
