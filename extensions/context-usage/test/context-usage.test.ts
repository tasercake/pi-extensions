import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerContextProvider } from "@mrclrchtr/supi-core/context";
import registerContextUsage, { buildLlmReadableReport } from "../src/context.ts";
import { analyzeContext, estimateTextTokens, extractInjectedContextFiles, type ContextAnalysis } from "../src/analysis.ts";
import { deriveOptionsFromSystemPrompt, extractGuidelinesSection } from "../src/prompt-inference.ts";
import { formatTokens, pluralize } from "../src/utils.ts";

const contextSource = new URL("../src/context.ts", import.meta.url);
const packageJson = new URL("../package.json", import.meta.url);

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function textContent(text: string) {
  return [{ type: "text", text }];
}

function messageEntry(id: string, parentId: string | null, message: any) {
  return { type: "message", id, parentId, timestamp: new Date(0).toISOString(), message };
}

function makeBranch() {
  return [
    messageEntry("u1", null, { role: "user", content: textContent("hello from user"), timestamp: 1 }),
    messageEntry("a1", "u1", {
      role: "assistant",
      content: [
        { type: "text", text: "assistant response" },
        { type: "thinking", thinking: "private-ish reasoning summary" },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/index.ts" } },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: usage(),
      stopReason: "toolUse",
      timestamp: 2,
    }),
    messageEntry("tr1", "a1", {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "read",
      content: textContent('<extension-context source="supi-claude-md" file="docs/ctx.md" turn="2">Injected docs content</extension-context>\nread output'),
      isError: false,
      timestamp: 3,
    }),
    {
      type: "compaction",
      id: "c1",
      parentId: "tr1",
      timestamp: new Date(0).toISOString(),
      summary: "Older context summary",
      firstKeptEntryId: "tr1",
      tokensBefore: 1234,
    },
    {
      type: "branch_summary",
      id: "b1",
      parentId: "c1",
      timestamp: new Date(0).toISOString(),
      summary: "Abandoned branch summary",
      fromId: "a1",
    },
    {
      type: "custom_message",
      id: "cm1",
      parentId: "b1",
      timestamp: new Date(0).toISOString(),
      customType: "test-custom",
      content: "custom extension context",
      display: true,
    },
    messageEntry("u2", "cm1", { role: "user", content: textContent("latest user prompt"), timestamp: 4 }),
    messageEntry("mystery", "u2", { role: "customish", content: "other message content", timestamp: 5 }),
  ];
}

function systemPrompt() {
  return `You are Pi.\n\nGuidelines:\n- Be concise in your responses\n- Use read to examine files instead of cat or sed.\n- Custom extension guideline\n\nPi documentation\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /tmp/project/AGENTS.md\n\nAgent rules\n\n## /outside/global/CLAUDE.md\n\nGlobal rules\n\n## /tmp/project/docs/extra.md\n\nExtra project context\n\nThe following skills provide specialized instructions for specific tasks.\n<available_skills>\n  <skill>\n    <name>demo-skill</name>\n    <description>Demo skill</description>\n    <location>/tmp/project/.pi/skills/demo/SKILL.md</location>\n  </skill>\n</available_skills>\nCurrent date: 2026-05-25\nCurrent working directory: /tmp/project`;
}

function promptOptions() {
  return {
    cwd: "/tmp/project",
    selectedTools: ["read", "write", "custom_tool"],
    toolSnippets: { read: "Read file contents", custom_tool: "Do custom work" },
    promptGuidelines: ["Custom extension guideline"],
    contextFiles: [
      { path: "/tmp/project/AGENTS.md", content: "Agent rules" },
      { path: "/outside/global/CLAUDE.md", content: "Global rules" },
      { path: "/tmp/project/docs/extra.md", content: "Extra project context" },
    ],
    skills: [{ name: "demo-skill", description: "Demo skill", filePath: "/tmp/project/.pi/skills/demo/SKILL.md" }],
    appendSystemPrompt: "Appended prompt text",
    customPrompt: "Custom base prompt",
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const branch = makeBranch();
  return {
    cwd: "/tmp/project",
    model: { id: "gpt-test", name: "GPT Test", provider: "openai" },
    getContextUsage: () => ({ tokens: 900, contextWindow: 2000, percent: 45 }),
    getSystemPrompt: systemPrompt,
    sessionManager: {
      getBranch: () => branch,
    },
    ...overrides,
  } as any;
}

function makePi() {
  const handlers: Record<string, Function[]> = {};
  const tools: any[] = [];
  const renderers: Record<string, Function> = {};
  return {
    handlers,
    tools,
    renderers,
    ui: { notify() {} },
    on(event: string, handler: Function) {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand() {
      throw new Error("slash commands should not be registered");
    },
    registerMessageRenderer(type: string, renderer: Function) {
      renderers[type] = renderer;
    },
    getActiveTools: () => ["read", "custom_tool"],
    getAllTools: () => [
      { name: "read", description: "Read files", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write", description: "Write files", parameters: { type: "object" } },
      { name: "custom_tool", description: "Custom tool desc", parameters: { type: "object", properties: { value: { type: "number" } } } },
    ],
  } as any;
}

test("package exposes only the context usage extension", async () => {
  const pkg = JSON.parse(await readFile(packageJson, "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.equal(pkg.name, "pi-context-usage");
});

test("extension registers get_context_usage tool and no slash command", async () => {
  const source = await readFile(contextSource, "utf8");
  assert.match(source, /name:\s*"get_context_usage"/);
  assert.match(source, /pi\.registerTool\(tool\)/);
  assert.doesNotMatch(source, /registerCommand\(/);
  assert.doesNotMatch(source, /supi-context/);
});

test("get_context_usage tool returns LLM-readable context tracking data", async () => {
  const pi = makePi();
  registerContextUsage(pi);
  assert.equal(pi.tools.length, 1);
  assert.equal(pi.tools[0].name, "get_context_usage");
  assert.equal(pi.handlers.before_agent_start.length, 1);
  await pi.handlers.before_agent_start[0]({ systemPromptOptions: promptOptions() });

  const unregister = registerContextProvider({
    id: "unit-provider",
    label: "Unit Provider",
    getData: () => ({ alpha: "beta", count: 2 }),
  });
  const result = await pi.tools[0].execute("call-1", { full: true }, undefined, undefined, makeCtx());
  unregister();
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /^Context usage:/);
  assert.match(result.content[0].text, /"modelName": "GPT Test"/);
  assert.match(result.content[0].text, /"toolDefinitions"/);
  assert.equal(result.details.analysis.totalTokens, 900);
  assert.equal(result.details.analysis.contextWindow, 2000);
  assert.equal(result.details.analysis.categories.autocompactBuffer > 0, true);
  assert.equal(result.details.analysis.systemPromptBreakdown.instructionFiles.length, 2);
  assert.equal(result.details.analysis.systemPromptBreakdown.contextFiles.length, 1);
  assert.equal(result.details.analysis.systemPromptBreakdown.skills[0].name, "demo-skill");
  assert.equal(result.details.analysis.toolDefinitions.count, 2);
  assert.equal(result.details.analysis.compaction.summarizedTurns, 1);
  assert.deepEqual(result.details.analysis.injectedFiles, [{ file: "docs/ctx.md", turn: 2, tokens: 6, lines: 1 }]);
  assert.ok(result.details.analysis.guidelineBullets.includes("Custom extension guideline"));
  assert.deepEqual(result.details.analysis.providerSections, [
    { id: "unit-provider", label: "Unit Provider", data: { alpha: "beta", count: 2 } },
  ]);

  const rendered = pi.tools[0].renderCall(
    { full: true },
    { bold: (text: string) => `**${text}**`, fg: (_name: string, text: string) => text },
  );
  assert.equal(rendered.constructor.name, "Text");
});

test("session_start clears cached options and analyzer derives prompt sources from system prompt", async () => {
  const pi = makePi();
  registerContextUsage(pi);
  await pi.handlers.before_agent_start[0]({ systemPromptOptions: promptOptions() });
  await pi.handlers.session_start[0]();

  const result = await pi.tools[0].execute("call-2", {}, undefined, undefined, makeCtx({ getContextUsage: () => undefined }));
  const analysis = result.details.analysis;
  assert.equal(analysis.approximationNote, "Approximate (no usage data available)");
  assert.equal(analysis.totalTokens > 0, true);
  assert.equal(analysis.systemPromptBreakdown.instructionFiles.length, 2);
  assert.equal(analysis.systemPromptBreakdown.contextFiles.length, 1);
  assert.equal(analysis.systemPromptBreakdown.skills[0].name, "demo-skill");
});

test("analyzeContext scales categories to provider token usage", () => {
  const analysis = analyzeContext(makeCtx(), makePi(), promptOptions(), false);
  assert.equal(analysis.scaled, true);
  assert.equal(analysis.totalTokens, 900);
  const used = analysis.categories.systemPrompt + analysis.categories.userMessages + analysis.categories.assistantMessages + analysis.categories.toolCalls + analysis.categories.toolResults + analysis.categories.other;
  assert.equal(used <= 905 && used >= 895, true);
  assert.equal(analysis.systemPromptBreakdown.guidelineSources.some((s) => s.source === "default"), true);
  assert.equal(analysis.systemPromptBreakdown.guidelineSources.some((s) => s.source === "read"), true);
  assert.equal(analysis.systemPromptBreakdown.guidelineSources.some((s) => s.source === "other"), true);
});

test("analyzeContext reports pending token count when provider usage is unavailable", () => {
  const analysis = analyzeContext(makeCtx({ getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }) }), makePi(), promptOptions(), false);
  assert.equal(analysis.approximationNote, "Token count pending — send a message to refresh");
  assert.equal(analysis.scaled, false);
  assert.equal(analysis.categories.freeSpace >= 0, true);
});

test("analyzeContext estimates string and malformed message content", () => {
  const branch = [
    messageEntry("u", null, { role: "user", content: "string user content", timestamp: 1 }),
    messageEntry("a", "u", { role: "assistant", content: "not array", api: "x", provider: "p", model: "m", usage: usage(), stopReason: "stop", timestamp: 2 }),
    messageEntry("tr", "a", { role: "toolResult", toolCallId: "t", toolName: "x", content: "plain tool result", isError: false, timestamp: 3 }),
    messageEntry("other", "tr", { role: "customish", content: [{ type: "text", text: "generic text" }, { type: "image", data: "ignored" }], timestamp: 4 }),
  ];
  const analysis = analyzeContext(
    makeCtx({
      sessionManager: { getBranch: () => branch },
      getContextUsage: () => ({ tokens: 0, contextWindow: 400, percent: 0 }),
      getSystemPrompt: () => "Prompt without a guidelines section",
    }),
    makePi(),
    { cwd: "/tmp/project", promptGuidelines: ["fallback guideline"], selectedTools: [], toolSnippets: undefined },
    false,
  );
  assert.equal(analysis.approximationNote, "Token count pending — send a message to refresh");
  assert.equal(analysis.categories.userMessages > 0, true);
  assert.equal(analysis.categories.toolResults > 0, true);
  assert.equal(analysis.categories.other > 0, true);
  assert.equal(analysis.systemPromptBreakdown.guidelines, estimateTextTokens("fallback guideline"));
});

test("prompt inference derives context files skills and guideline section", () => {
  const inferred = deriveOptionsFromSystemPrompt(makeCtx(), undefined)!;
  assert.equal(inferred.cwd, "/tmp/project");
  assert.equal(inferred.contextFiles?.length, 3);
  assert.equal(inferred.skills?.[0].name, "demo-skill");
  const guidelines = extractGuidelinesSection(systemPrompt())!;
  assert.match(guidelines, /Be concise/);
  assert.match(guidelines, /Custom extension guideline/);
  assert.equal(extractGuidelinesSection("No guideline marker"), null);
});

test("prompt inference handles project contexts without intro, skills marker, or date marker", () => {
  const prompt = `Header\n\n# Project Context\n\n## relative/NOTE.md\n\nRelative note\n\n## SYSTEM.md\n\nSystem note`;
  const ctx = makeCtx({ getSystemPrompt: () => prompt });
  const inferred = deriveOptionsFromSystemPrompt(ctx, undefined)!;
  assert.deepEqual(inferred.contextFiles?.map((f) => f.path), ["relative/NOTE.md", "SYSTEM.md"]);
  assert.deepEqual(inferred.skills, []);
});

test("prompt inference ignores non-file-looking headings and trims single newlines", () => {
  const prompt = `Header\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## Not A File Heading\n\nIgnored\n\n## ~/AGENTS.md\nOne newline wrapped\nCurrent date: 2026-05-25`;
  const ctx = makeCtx({ getSystemPrompt: () => prompt });
  const inferred = deriveOptionsFromSystemPrompt(ctx, undefined)!;
  assert.deepEqual(inferred.contextFiles, [{ path: "~/AGENTS.md", content: "\nOne newline wrapped" }]);
});

test("prompt inference merges cached options with derived missing fields", () => {
  const inferred = deriveOptionsFromSystemPrompt(makeCtx(), { cwd: "/tmp/project", contextFiles: [], skills: [] })!;
  assert.equal(inferred.contextFiles?.length, 3);
  assert.equal(inferred.skills?.length, 1);
  const cachedWins = deriveOptionsFromSystemPrompt(makeCtx(), promptOptions() as any)!;
  assert.deepEqual(cachedWins.contextFiles, promptOptions().contextFiles);
  const none = deriveOptionsFromSystemPrompt(makeCtx({ getSystemPrompt: () => "plain prompt" }), undefined);
  assert.equal(none, undefined);
});

test("extractInjectedContextFiles deduplicates by file and turn", () => {
  const messages: any[] = [
    { role: "toolResult", content: textContent('<extension-context source="supi-claude-md" file="a.md" turn="1">one</extension-context>') },
    { role: "toolResult", content: textContent('<extension-context source="supi-claude-md" file="a.md" turn="1">one duplicate</extension-context><extension-context source="supi-claude-md" file="b.md" turn="2">two\nlines</extension-context>') },
    { role: "user", content: "ignored" },
  ];
  assert.deepEqual(extractInjectedContextFiles(messages), [
    { file: "a.md", turn: 1, tokens: 1, lines: 1 },
    { file: "b.md", turn: 2, tokens: 3, lines: 2 },
  ]);
});

test("analysis covers uncompacted legacy message shapes and prompt-guideline fallback", () => {
  const branch = [
    messageEntry("u1", null, { role: "user", content: "plain string user", timestamp: 1 }),
    messageEntry("u2", "u1", { role: "user", content: undefined, timestamp: 2 }),
    messageEntry("a1", "u2", { role: "assistant", content: "legacy assistant string", timestamp: 3 }),
    messageEntry("a2", "a1", {
      role: "assistant",
      content: [
        { type: "text", text: "assistant text" },
        { type: "thinking", thinking: "assistant thinking" },
        { type: "toolCall", name: "custom_tool", arguments: { value: 42 } },
      ],
      timestamp: 4,
    }),
    messageEntry("tr1", "a2", { role: "toolResult", content: "string tool result", timestamp: 5 }),
  ];
  const analysis = analyzeContext(
    makeCtx({
      getContextUsage: () => ({ tokens: 0, contextWindow: 50000, percent: null }),
      getSystemPrompt: () => "System prompt without guidelines section",
      sessionManager: { getBranch: () => branch },
      model: undefined,
    }),
    makePi(),
    { cwd: "/tmp/project", promptGuidelines: ["fallback guideline"] } as any,
    false,
  );

  assert.equal(analysis.modelName, "No model selected");
  assert.equal(analysis.compaction, null);
  assert.equal(analysis.approximationNote, "Token count pending — send a message to refresh");
  assert.equal(analysis.systemPromptBreakdown.guidelines, estimateTextTokens("fallback guideline"));
  assert.equal(analysis.systemPromptBreakdown.toolSnippetDetails.length, 0);
  assert.equal(analysis.categories.userMessages > 0, true);
  assert.equal(analysis.categories.assistantMessages > 0, true);
  assert.equal(analysis.categories.toolCalls > 0, true);
  assert.equal(analysis.categories.toolResults > 0, true);
});

test("prompt inference covers nonstandard headings, missing sections, date delimiters, and XML escapes", () => {
  const prompt = `Preamble

# Project Context

## folder\\windows.md

Windows path context

## ~/home.md

Home context

## AGENTS.md

Agent context

Current date: 2026-05-25

<available_skills>
  <skill>
    <name>escaped &amp; skill</name>
    <description>&lt;desc&gt; &quot;quoted&quot; &apos;single&apos;</description>
    <location>/tmp/escaped.md</location>
  </skill>
</available_skills>`;
  const inferred = deriveOptionsFromSystemPrompt({ ...makeCtx(), getSystemPrompt: () => prompt } as any, undefined)!;
  assert.deepEqual(inferred.contextFiles?.map((file) => file.path), ["folder\\windows.md", "~/home.md", "AGENTS.md"]);
  assert.equal(inferred.skills?.[0].name, "escaped & skill");
  assert.equal(inferred.skills?.[0].description, `<desc> "quoted" 'single'`);

  assert.equal(extractGuidelinesSection("no guidelines"), null);
  assert.equal(deriveOptionsFromSystemPrompt({ ...makeCtx(), getSystemPrompt: () => "plain prompt" } as any, undefined), undefined);
  assert.equal(
    deriveOptionsFromSystemPrompt({ ...makeCtx(), getSystemPrompt: () => "plain prompt" } as any, { cwd: "/tmp/project", contextFiles: [{ path: "x", content: "y" }], skills: [{ name: "kept", description: "kept", filePath: "z" }] } as any)?.skills?.[0].name,
    "kept",
  );
});

test("guideline source sorting handles other-last and tool-name ordering", () => {
  const prompt = `System

Guidelines:
- Bespoke extension guideline
- Use write only for new files or complete rewrites.
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)

Current date: 2026-05-25`;
  const analysis = analyzeContext(
    makeCtx({ getSystemPrompt: () => prompt, getContextUsage: () => undefined }),
    makePi(),
    undefined,
    false,
  );

  assert.deepEqual(analysis.guidelineSources.map((source) => source.source), [
    "edit",
    "read",
    "write",
    "other",
  ]);
});

test("utility helpers format token counts and plural forms", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1200), "1.2k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(pluralize(1, "token", "tokens"), "1 token");
  assert.equal(pluralize(2, "token", "tokens"), "2 tokens");
});

test("buildLlmReadableReport handles unknown context window", () => {
  const analysis: ContextAnalysis = {
    modelName: "No model",
    contextWindow: 0,
    totalTokens: null,
    scaled: false,
    approximationNote: null,
    full: false,
    categories: { systemPrompt: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, other: 0, autocompactBuffer: 0, freeSpace: 0 },
    systemPromptBreakdown: { base: 0, instructionFiles: [], contextFiles: [], skills: [], guidelines: 0, toolSnippets: 0, toolSnippetDetails: [], guidelineSources: [], appendText: 0 },
    injectedFiles: [],
    skills: [],
    guidelines: 0,
    guidelineBullets: [],
    guidelineSources: [],
    toolSnippetDetails: [],
    toolDefinitions: { count: 0, tokens: 0, tools: [] },
    compaction: null,
    providerSections: [],
  };
  const report = buildLlmReadableReport(analysis);
  assert.match(report, /^Context usage: 0 tokens\./);
  assert.match(report, /"modelName": "No model"/);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12_345), "12.3k");
  assert.equal(formatTokens(1_234_567), "1.2M");
  assert.equal(pluralize(1, "file", "files"), "1 file");
  assert.equal(pluralize(2, "file", "files"), "2 files");
});

test("tool renderCall renders full suffix", async () => {
  const pi = makePi();
  registerContextUsage(pi);
  const rendered = pi.tools[0].renderCall({ full: true }, { fg: (_kind: string, text: string) => text, bold: (text: string) => text });
  assert.equal(rendered.constructor.name, "Text");
});
