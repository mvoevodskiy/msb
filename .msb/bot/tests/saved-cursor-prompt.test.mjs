/**
 * Cursor saved-prompt admission, freshness and dispatcher wiring (TZ open-core).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { savedPromptPlan, savedPromptProvider, legacyCursorSavedPrompt, ordinarySavedPrompt }
  from '../src/autonomy/prompt-policy.mjs';
import { checkSavedPromptFreshness } from '../src/autonomy/prompt-freshness.mjs';
import { runSavedPrompt } from '../src/autonomy/prompt-turn.mjs';
import { createReminderDispatcher } from '../src/autonomy/reminder-dispatch.mjs';
import { actionRoot } from '../src/paths.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';

const owner = -100777;
const now = Date.parse('2026-11-11T12:00:00.000Z');

const editorial = {
  id: 'conv-prompt-editorial',
  name: 'Редакция',
  enabled: true,
  runner: 'auto',
  trigger: { kind: 'cron', cron: '0 9,12,15,18,21 * * *' },
  task: {
    kind: 'prompt',
    prompt: 'Собери редакционный отчёт',
    freshness: { paths: [], maxAgeHours: 3 },
  },
  capability: 'read',
  authority: { profile: 'standard' },
  budget: { maxRunSeconds: 3600 },
  output: { format: 'tg-message' },
};

const askWatch = {
  id: 'conv-prompt-ask-watch',
  name: 'Дозор ask',
  enabled: true,
  runner: 'auto',
  trigger: { kind: 'cron', cron: '0 8-22 * * *' },
  task: { kind: 'prompt', prompt: 'pult ask list', shell: true },
  capability: 'scan',
  authority: { profile: 'inspect' },
  output: { format: 'tg-message', emptyIsValidOutcome: true },
};

const growth = {
  id: 'conv-prompt-growth',
  name: 'Рост аудитории',
  enabled: true,
  runner: 'auto',
  trigger: { kind: 'cron', cron: '0 10 * * *' },
  task: { kind: 'prompt', prompt: 'Рост' },
  capability: 'read',
  authority: { profile: 'standard' },
  run: { memory: 'continuous' },
  handoff: { next: 'Проверить сводку' },
  output: { format: 'tg-message' },
};

function cursorState(extra = {}) {
  return {
    engine: 'cc',
    authMode: 'subscription',
    hasSubscriptionAuth: false,
    extAuthBypass: 'cursor',
    chatId: owner,
    userId: 42,
    timezone: 'Europe/Moscow',
    ...extra,
  };
}

test('savedPromptProvider returns cursor without Claude OAuth', () => {
  const state = cursorState();
  assert.equal(savedPromptProvider(state, {}, false, true), 'cursor');
  assert.equal(savedPromptProvider(state, {}, false, false), undefined);
  assert.equal(savedPromptProvider(state, { JARVIS_CC_ONLY: '1' }, false, true), undefined);
});

test('legacy Cursor admission covers editorial freshness and ask-watch shell', () => {
  assert.equal(ordinarySavedPrompt(editorial), false);
  assert.equal(ordinarySavedPrompt(askWatch), false);
  assert.equal(ordinarySavedPrompt(growth), false);
  assert.equal(legacyCursorSavedPrompt(editorial), true);
  assert.equal(legacyCursorSavedPrompt(askWatch), true);
  assert.equal(legacyCursorSavedPrompt(growth), true);
});

test('savedPromptPlan for cursor admits fixtures and respects budget ceiling', () => {
  const state = cursorState();
  const plan = savedPromptPlan(editorial, state, {}, false, true);
  assert.equal(plan?.provider, 'cursor');
  assert.equal(plan.timeoutMs, 3600 * 1000 - 15_000);
  assert.equal(plan.quiet, false);

  const watch = savedPromptPlan(askWatch, state, {}, false, true);
  assert.equal(watch?.provider, 'cursor');
  assert.equal(watch.shell, true);
  assert.equal(watch.quiet, true);
  assert.ok(watch.tools.includes('Bash'));
  assert.equal(watch.timeoutMs, 1200 * 1000 - 15_000);

  const cont = savedPromptPlan(growth, state, {}, false, true);
  assert.equal(cont?.continuous, true);
  assert.equal(cont?.handoff, true);

  assert.equal(savedPromptPlan(editorial, state, {}, false, false), undefined);
  assert.equal(savedPromptPlan(editorial, { ...state, extAuthBypass: undefined, hasSubscriptionAuth: true },
    { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, false, true), undefined);
});

test('incompatible cursor task.model becomes modelError, not silent empty plan', () => {
  const state = cursorState();
  const plan = savedPromptPlan({
    ...editorial,
    task: { ...editorial.task, model: 'opus' },
  }, state, {}, false, true);
  assert.equal(plan?.provider, 'cursor');
  assert.match(plan.modelError, /не совместима с Cursor/);
});

test('freshness stale refuses quietly and reports path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-fresh-'));
  const feed = path.join(root, 'status.json');
  await fs.writeFile(feed, '{}');
  const past = Date.now() - 4 * 3_600_000;
  await fs.utimes(feed, past / 1000, past / 1000);
  const action = {
    ...editorial,
    task: { ...editorial.task, freshness: { paths: [feed], maxAgeHours: 3 } },
  };
  const stale = await checkSavedPromptFreshness(action, { now: Date.now() });
  assert.equal(stale.ok, false);
  assert.equal(stale.path, path.resolve(feed));

  const freshFile = path.join(root, 'fresh.json');
  await fs.writeFile(freshFile, '{}');
  const ok = await checkSavedPromptFreshness({
    ...action,
    task: { ...action.task, freshness: { paths: [freshFile], maxAgeHours: 3 } },
  });
  assert.equal(ok.ok, true);

  const result = await runSavedPrompt(action, {
    provider: 'cursor', tools: [], timeoutMs: 60_000, quiet: true,
  }, {
    signal: AbortSignal.timeout(5_000),
    isCurrent: async () => true,
    runCursorPrompt: async () => assert.fail('stale must not spawn'),
  });
  assert.equal(result.status, 'error');
  assert.equal(result.stale, true);
  assert.match(result.text, /источник протух/);
  await fs.rm(root, { recursive: true, force: true });
});

test('dispatcher claims due cursor prompt and calls cursor runner', async t => {
  const f = await fixture(t, async () => assert.fail('owner turn must not run'),
    { overlay: false, runtimeProfile: 'jar1' });
  process.env.AUTONOMY_ENABLED = '1';
  for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY']) delete process.env[key];
  await saveState({ ...(await loadState()).state, ...cursorState() });
  const root = actionRoot();
  const autonomy = path.join(root, 'autonomy');
  await fs.mkdir(autonomy, { recursive: true });
  const feed = path.join(autonomy, 'feed-status.json');
  await fs.writeFile(feed, '{"ok":true}');
  const action = {
    ...editorial,
    trigger: { kind: 'interval', intervalMinutes: 60 },
    lastRunAt: new Date(now - 3_600_000).toISOString(),
    task: { ...editorial.task, freshness: { paths: [feed], maxAgeHours: 3 } },
  };
  await fs.writeFile(path.join(root, 'actions.json'), JSON.stringify([action]));

  const sent = [];
  const originalSend = f.bot.api.sendMessage;
  f.bot.api.sendMessage = async (chat, message, ...options) => {
    sent.push({ chat, text: message });
    return originalSend(chat, message, ...options);
  };

  let cursorCalls = 0;
  const logs = [];
  const dispatch = createReminderDispatcher({
    api: f.bot.api,
    adminId: 42,
    timezone: 'Europe/Moscow',
    now: () => now,
    log: line => logs.push(line),
    signal: AbortSignal.timeout(30_000),
    runCursorPrompt: async (opts) => {
      cursorCalls += 1;
      assert.equal(opts.actionId, action.id);
      assert.match(opts.cwd, /cursor-workspace$/);
      return {
        providerId: 'cursor',
        text: 'Отчёт редакции',
        assistantTextObserved: true,
        isError: false,
        usage: { inputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 2 },
      };
    },
  });

  await dispatch(() => false);
  assert.equal(cursorCalls, 1);
  assert.ok(sent.some(row => String(row.text).includes('Отчёт редакции') || String(row.text).includes('Готово')));
  const runs = (await fs.readFile(path.join(autonomy, 'runs.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(runs[0]?.status, 'ok');
  const saved = JSON.parse(await fs.readFile(path.join(root, 'actions.json'), 'utf8'));
  assert.ok(saved[0].lastRunAt);
});

test('due prompt without plan logs skip reason once per tick', async t => {
  const f = await fixture(t, async () => assert.fail('owner turn must not run'),
    { overlay: false, runtimeProfile: 'jar1' });
  process.env.AUTONOMY_ENABLED = '1';
  await saveState({ ...(await loadState()).state, ...cursorState() });
  const root = actionRoot();
  await fs.mkdir(path.join(root, 'autonomy'), { recursive: true });
  const blocked = {
    ...askWatch,
    trigger: { kind: 'interval', intervalMinutes: 60 },
    lastRunAt: new Date(now - 3_600_000).toISOString(),
    // act+approval is P2 — still no-plan under cursor legacy admission
    requiresApproval: true,
    capability: 'act',
  };
  await fs.writeFile(path.join(root, 'actions.json'), JSON.stringify([blocked]));
  const logs = [];
  const dispatch = createReminderDispatcher({
    api: f.bot.api,
    adminId: 42,
    timezone: 'Europe/Moscow',
    now: () => now,
    log: line => logs.push(line),
    signal: AbortSignal.timeout(10_000),
    runCursorPrompt: async () => assert.fail('blocked action must not run'),
  });
  await dispatch(() => false);
  assert.ok(logs.some(line => line.includes('skip ' + blocked.id) && line.includes('reason=no-plan')));
});
