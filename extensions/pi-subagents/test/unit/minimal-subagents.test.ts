import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import registerSubagentExtension from '../../src/extension/index.ts';
import { SpawnSubagentParams, GetSubagentStatusParams, ListSubagentsParams } from '../../src/extension/schemas.ts';
import { createMockPi } from '../support/mock-pi.ts';
import { CHILD_SUBAGENT_SYSTEM_LINE, rewriteSubagentPrompt } from '../../src/runs/shared/subagent-prompt-runtime.ts';
import { buildPiArgs } from '../../src/runs/shared/pi-args.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

function makeTestCtx(prefix: string) {
  const sessionId = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    sessionId,
    ctx: {
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)),
      sessionManager: {
        getSessionFile: () => sessionId,
        getSessionId: () => sessionId,
      },
    },
  };
}

function cleanupTestCtx(ctx: { cwd: string }, sessionId: string) {
  fs.rmSync(ctx.cwd, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.pi', 'agent', 'subagents-minimal', sessionId), { recursive: true, force: true });
}

function registerTestTools(sendMessage: (...args: unknown[]) => void) {
  const registered = new Map<string, any>();
  const fakePi = {
    registerTool(tool: { name: string }) {
      registered.set(tool.name, tool);
    },
    sendMessage,
  };
  registerSubagentExtension(fakePi as never);
  return {
    spawnTool: registered.get('spawn_subagent'),
    statusTool: registered.get('get_subagent_status'),
    listTool: registered.get('list_subagents'),
  };
}

async function waitForStatus(statusTool: any, id: string, ctx: unknown) {
  let status: any;
  for (let i = 0; i < 100; i++) {
    status = await statusTool.execute(
      `status-${id}-${i}`,
      { id },
      new AbortController().signal,
      undefined,
      ctx,
    );
    if (!status.details.running) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return status;
}

test('schemas expose minimal three-tool parameter shapes', async () => {
  assert.equal(SpawnSubagentParams.additionalProperties, false);
  assert.deepEqual(Object.keys(SpawnSubagentParams.properties).sort(), ['async', 'cwd', 'keepContext', 'model', 'outputMode', 'task'].sort());
  assert.equal(GetSubagentStatusParams.additionalProperties, false);
  assert.deepEqual(Object.keys(GetSubagentStatusParams.properties), ['id']);
  assert.equal(ListSubagentsParams.additionalProperties, false);
  assert.deepEqual(Object.keys(ListSubagentsParams.properties), []);

  const schemas = await import('../../src/extension/schemas.ts');
  assert.equal('SteerSubagentParams' in schemas, false);
});

test('extension registers only spawn status and list tools', () => {
  const registered: Array<{ name: string }> = [];
  const fakePi = {
    registerTool(tool: { name: string }) {
      registered.push(tool);
    },
    sendMessage() {
      throw new Error('sendMessage should not be called during registration');
    },
  };

  registerSubagentExtension(fakePi as never);

  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['spawn_subagent', 'get_subagent_status', 'list_subagents'],
  );

  const toolNames = new Set(registered.map((tool) => tool.name));
  assert.equal(toolNames.has('steer_subagent'), false);
  assert.equal(toolNames.has('resume_subagent'), false);
  assert.equal(toolNames.has('follow_up_subagent'), false);
  assert.equal(toolNames.has('interrupt_subagent'), false);
});

test('user-facing packaged docs do not expose removed API concepts', () => {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJsonText = fs.readFileSync(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageJsonText) as { files?: string[] };

  assert.equal(
    (packageJson.files ?? []).includes('CHANGELOG.md'),
    false,
    'CHANGELOG.md must not be packaged unless removed-interaction wording is rewritten and covered by this test',
  );

  const files = [
    'README.md',
    'skills/pi-subagents/SKILL.md',
    'package.json',
    'install.mjs',
  ];
  const forbidden = [
    'steer_subagent',
    'steering',
    'follow-up',
    'message queue',
    'message-queue',
    'Queues a message for a running subagent',
    'resumes a stopped subagent',
    'replacement',
  ];

  for (const relativePath of files) {
    const text = fs
      .readFileSync(path.join(projectRoot, relativePath), 'utf-8')
      .toLowerCase();
    for (const term of forbidden) {
      assert.equal(
        text.includes(term.toLowerCase()),
        false,
        `${relativePath} mentions ${term}`,
      );
    }
  }
});

test('prompt runtime prepends exactly one line and preserves content', () => {
  const prompt = 'SYSTEM\n\n# Project Context\nkeep this\n\nThe following skills provide specialized instructions for specific tasks.\nkeep skills';
  const rewritten = rewriteSubagentPrompt(prompt);
  assert.equal(rewritten, `${CHILD_SUBAGENT_SYSTEM_LINE}\n\n${prompt}`);
  assert.equal(rewriteSubagentPrompt(rewritten), rewritten);
  assert(!rewritten.includes('Do not propose or run subagents'));
});

test('child pi args do not restrict tools skills extensions or MCP', () => {
  const built = buildPiArgs({ baseArgs: [], task: 'hello', sessionEnabled: true, sessionFile: '/tmp/pi-subagent-test/session.jsonl' });
  assert(!built.args.includes('--no-skills'));
  assert(!built.args.includes('--no-extensions'));
  assert(!built.args.includes('--tools'));
  assert.equal(built.env.MCP_DIRECT_TOOLS, undefined);
  assert(built.args.includes('--extension'));
});

test('async completion persists success when stale extension context rejects notification', async () => {
  const mockPi = createMockPi();
  mockPi.install();
  mockPi.onCall({ output: 'done', exitCode: 0 });

  const { sessionId, ctx } = makeTestCtx('pi-subagents-stale');
  let notifyAttempts = 0;
  const { spawnTool, statusTool } = registerTestTools(() => {
    notifyAttempts += 1;
    throw new Error('This extension ctx is stale after session replacement or reload.');
  });

  try {
    await spawnTool.execute(
      'stale-notify-child',
      { task: 'finish', async: true, keepContext: false, outputMode: 'inline' },
      new AbortController().signal,
      undefined,
      ctx,
    );

    const status = await waitForStatus(statusTool, 'stale-notify-child', ctx);

    assert.equal(status.details.running, false);
    assert.equal(status.details.result, 'done');
    assert.equal(status.details.error, undefined);
    assert.equal(notifyAttempts, 1);
  } finally {
    mockPi.uninstall();
    cleanupTestCtx(ctx, sessionId);
  }
});

test('stale cohort notification failure does not suppress later final notification', async () => {
  const mockPi = createMockPi();
  mockPi.install();
  mockPi.onCall({ output: 'first', exitCode: 0, delay: 20 });
  mockPi.onCall({ output: 'second', exitCode: 0, delay: 120 });

  const { sessionId, ctx } = makeTestCtx('pi-subagents-stale-cohort');
  const sentMessages: string[] = [];
  let notifyAttempts = 0;
  const { spawnTool, statusTool } = registerTestTools((message) => {
    notifyAttempts += 1;
    if (notifyAttempts === 1) {
      throw new Error('This extension ctx is stale after session replacement or reload.');
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') sentMessages.push(content);
  });

  try {
    await spawnTool.execute(
      'stale-cohort-first',
      { task: 'finish first', async: true, keepContext: false, outputMode: 'inline' },
      new AbortController().signal,
      undefined,
      ctx,
    );
    await spawnTool.execute(
      'stale-cohort-second',
      { task: 'finish second', async: true, keepContext: false, outputMode: 'inline' },
      new AbortController().signal,
      undefined,
      ctx,
    );

    const firstStatus = await waitForStatus(statusTool, 'stale-cohort-first', ctx);
    const secondStatus = await waitForStatus(statusTool, 'stale-cohort-second', ctx);

    assert.equal(firstStatus.details.result, 'first');
    assert.equal(secondStatus.details.result, 'second');
    assert.equal(firstStatus.details.error, undefined);
    assert.equal(secondStatus.details.error, undefined);
    assert.equal(notifyAttempts, 2);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /All 2 subagents have completed\./);
    assert.match(sentMessages[0], /stale-cohort-second/);
  } finally {
    mockPi.uninstall();
    cleanupTestCtx(ctx, sessionId);
  }
});
