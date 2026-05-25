import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { analyzeContext, type ContextAnalysis } from "./analysis.ts";
import { formatTokens } from "./utils.ts";

const GetContextUsageParams = Type.Object(
  {
    full: Type.Optional(
      Type.Boolean({
        description:
          "Include all extracted guideline bullets in the returned analysis. Defaults to false.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface GetContextUsageParamsLike {
  full?: boolean;
}

interface GetContextUsageDetails {
  analysis: ContextAnalysis;
}

function pct(value: number | null | undefined, total: number): string | null {
  if (value === null || value === undefined || total <= 0) return null;
  return `${((value / total) * 100).toFixed(1)}%`;
}

function sumTokens<T extends { tokens: number }>(items: T[]): number {
  return items.reduce((total, item) => total + item.tokens, 0);
}

function buildLlmReadableReport(analysis: ContextAnalysis): string {
  const used = analysis.totalTokens ?? 0;
  const usagePercent = pct(analysis.totalTokens, analysis.contextWindow);
  const system = analysis.systemPromptBreakdown;
  const systemComposition = {
    base: system.base,
    instructionFiles: sumTokens(system.instructionFiles),
    contextFiles: sumTokens(system.contextFiles),
    skills: sumTokens(system.skills),
    guidelines: system.guidelines,
    toolSnippets: system.toolSnippets,
    appendText: system.appendText,
  };

  const payload = {
    summary: {
      modelName: analysis.modelName,
      contextWindow: analysis.contextWindow,
      totalTokens: analysis.totalTokens,
      usedTokensFormatted: formatTokens(used),
      contextWindowFormatted: formatTokens(analysis.contextWindow),
      usagePercent,
      approximationNote: analysis.approximationNote,
      scaledToProviderUsage: analysis.scaled,
    },
    categories: analysis.categories,
    systemPromptComposition: systemComposition,
    systemPromptBreakdown: analysis.systemPromptBreakdown,
    injectedFiles: analysis.injectedFiles,
    skills: analysis.skills,
    guidelines: {
      tokens: analysis.guidelines,
      sources: analysis.guidelineSources,
      bullets: analysis.full ? analysis.guidelineBullets : undefined,
    },
    toolSnippets: analysis.toolSnippetDetails,
    toolDefinitions: analysis.toolDefinitions,
    compaction: analysis.compaction,
    providerSections: analysis.providerSections,
  };

  const headline =
    analysis.contextWindow > 0
      ? `Context usage: ${formatTokens(used)} / ${formatTokens(analysis.contextWindow)} tokens (${usagePercent}).`
      : `Context usage: ${formatTokens(used)} tokens.`;
  const note = analysis.approximationNote ? `\nNote: ${analysis.approximationNote}` : "";

  return `${headline}${note}\n\n${JSON.stringify(payload, null, 2)}`;
}

export default function contextUsageExtension(pi: ExtensionAPI): void {
  let cachedOptions: BuildSystemPromptOptions | undefined;

  pi.on("before_agent_start", async (event) => {
    cachedOptions = event.systemPromptOptions;
  });

  pi.on("session_start", async () => {
    cachedOptions = undefined;
  });

  const tool: ToolDefinition<typeof GetContextUsageParams, GetContextUsageDetails> = {
    name: "get_context_usage",
    label: "Get context usage",
    description:
      "Analyze the current Pi conversation context: token usage by category, system prompt composition, context/instruction files, skills, tool definitions, compaction, and remaining context window. Returns an LLM-readable text summary followed by structured JSON.",
    parameters: GetContextUsageParams,
    async execute(
      _toolCallId: string,
      params: GetContextUsageParamsLike,
      _signal: AbortSignal | undefined,
      _onUpdate: ((result: unknown) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      const analysis = analyzeContext(ctx, pi, cachedOptions, params.full === true);
      return {
        content: [{ type: "text", text: buildLlmReadableReport(analysis) }],
        details: { analysis },
      };
    },
    renderCall(args, theme) {
      const suffix = args.full ? " full" : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("get_context_usage"))}${suffix}`, 0, 0);
    },
  };

  pi.registerTool(tool);
}

export { buildLlmReadableReport };
