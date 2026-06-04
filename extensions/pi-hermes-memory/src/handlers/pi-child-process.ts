import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig, ThinkingLevel } from "../types.js";

type ChildLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

interface PiExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

interface ExecChildPromptOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  retryWithoutOverrides?: boolean;
}

const OVERRIDE_FAILURE_SUBJECT = /\b(model|provider|thinking)\b/i;
const OVERRIDE_FAILURE_REASON = /\b(not found|unknown|invalid|unsupported|unavailable|unrecognized|no match|no matches|cannot resolve|failed to resolve)\b/i;

function normalizedModelOverride(config: ChildLlmConfig): string | undefined {
  const trimmed = config.llmModelOverride?.trim();
  return trimmed ? trimmed : undefined;
}

function effectiveThinkingOverride(config: ChildLlmConfig): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? (normalizedModelOverride(config) ? "off" : undefined);
}

export function hasChildLlmOverrides(config: ChildLlmConfig): boolean {
  return normalizedModelOverride(config) !== undefined || effectiveThinkingOverride(config) !== undefined;
}

export function inheritedExtensionArgs(argv: string[] = process.argv.slice(2)): string[] {
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === "-e" || current === "--extension") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.length > 0) {
        args.push(current, next);
        i++;
      }
      continue;
    }

    if (current.startsWith("--extension=")) {
      args.push(current);
    }
  }

  return args;
}

export function buildChildPiPromptArgs(prompt: string, config: ChildLlmConfig, argv: string[] = process.argv.slice(2)): string[] {
  const args = ["-p", "--no-session"];
  const model = normalizedModelOverride(config);
  const thinking = effectiveThinkingOverride(config);
  const inheritedExtensions = inheritedExtensionArgs(argv);

  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  args.push(...inheritedExtensions);
  args.push(prompt);

  return args;
}

function basePromptArgs(prompt: string): string[] {
  return ["-p", "--no-session", prompt];
}

function shouldRetryWithoutOverridesFromText(text: string | undefined): boolean {
  if (!text) return false;
  return OVERRIDE_FAILURE_SUBJECT.test(text) && OVERRIDE_FAILURE_REASON.test(text);
}

function shouldRetryWithoutOverrides(result: PiExecResult): boolean {
  return shouldRetryWithoutOverridesFromText(result.stderr) || shouldRetryWithoutOverridesFromText(result.stdout);
}

function shouldRetryWithoutOverridesForError(error: unknown): boolean {
  return shouldRetryWithoutOverridesFromText(String(error));
}

export async function execChildPrompt(
  pi: Pick<ExtensionAPI, "exec">,
  prompt: string,
  config: ChildLlmConfig,
  options: ExecChildPromptOptions,
): Promise<PiExecResult> {
  const execOptions = {
    signal: options.signal,
    timeout: options.timeoutMs,
  };

  try {
    const result = await pi.exec("pi", buildChildPiPromptArgs(prompt, config), execOptions) as PiExecResult;
    if (
      result.code === 0 ||
      !options.retryWithoutOverrides ||
      !hasChildLlmOverrides(config) ||
      !shouldRetryWithoutOverrides(result)
    ) {
      return result;
    }
  } catch (error) {
    if (
      !options.retryWithoutOverrides ||
      !hasChildLlmOverrides(config) ||
      !shouldRetryWithoutOverridesForError(error)
    ) {
      throw error;
    }
  }

  return pi.exec("pi", basePromptArgs(prompt), execOptions) as Promise<PiExecResult>;
}
