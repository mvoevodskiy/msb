// The real Telegram turn must not announce a missing answer before a delivered attachment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';

async function until(check, label) {
  const end = performance.now() + 10000;
  while (!check()) {
    if (performance.now() > end) throw Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const [provider, marker, file, method] of [
  ['codex', 'ФАЙЛ', 'only-file.txt', 'sendDocument'],
  ['claude', 'ФОТО', 'only-photo.png', 'sendPhoto'],
]) {
  test(`${provider} attachment-only response delivers ${method} without a false missing-answer notice`, async t => {
    const f = await mcpFixture(t, provider, { runTurn: runAgentTurn });
    const native = await nativeFixtures(f);
    const events = [], sendMedia = f.bot.api[method], sendMessage = f.bot.api.sendMessage;
    t.mock.method(f.bot.api, method, async (...args) => { events.push('media'); return sendMedia(...args); });
    t.mock.method(f.bot.api, 'sendMessage', async (...args) => {
      if (String(args[1]).includes('⏱')) events.push('footer');
      return sendMessage(...args);
    });
    await fs.writeFile(path.join(f.workspace, file), 'synthetic attachment');
    await native.respond(`[${marker}: ${file} Подпись]`);
    await f.message('Отправь вложение');
    await until(() => f.mediaSends.length === 1 && events.includes('footer'), 'attachment and footer');
    await f.bot.stop();
    assert.equal(f.mediaSends[0].method, method);
    assert.equal(f.mediaSends[0].media.filename, file);
    assert.equal(f.mediaSends[0].options.caption, 'Подпись');
    assert.ok(f.deleted.includes(1), 'only the outgoing thinking status is removed');
    assert.ok(!f.deleted.includes(99), 'the incoming user message is retained');
    assert.ok(!f.messages.some(text => text.includes('Ответ не пришёл')));
    assert.deepEqual(events, ['media', 'footer'], 'the existing telemetry follows the confirmed attachment');
    const turns = (await native.trace()).filter(row => ['claude', 'codex-app-turn'].includes(row.kind));
    assert.equal(turns.length, 1);
    assert.equal(turns[0].kind, provider === 'codex' ? 'codex-app-turn' : 'claude');
  });
}

test('failed attachment-only delivery keeps the missing-answer fallback and logs the failure', async t => {
  const f = await fixture(t, async () => ({ ok: true, text: '[ФАЙЛ: rejected.txt]' }), { overlay: false });
  await fs.writeFile(path.join(f.workspace, 'rejected.txt'), 'synthetic attachment');
  let attempts = 0;
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  t.mock.method(f.bot.api, 'sendDocument', async () => { attempts++; throw Error('synthetic rejection'); });
  await f.message('Отправь файл');
  await until(() => attempts === 1 && f.messages.some(text => text.includes('Ответ не пришёл')), 'failure fallback');
  await f.bot.stop();
  assert.equal(attempts, 1);
  assert.equal(f.mediaSends.length, 0);
  assert.ok(errors.some(text => text.includes('send_media failed')));
});

test('a footer transport failure does not turn a delivered attachment into a false error', async t => {
  const f = await fixture(t, async () => ({ ok: true, text: '[ФАЙЛ: delivered.txt]' }), { overlay: false });
  await fs.writeFile(path.join(f.workspace, 'delivered.txt'), 'synthetic attachment');
  let footerAttempts = 0;
  const errors = [], sendMessage = f.bot.api.sendMessage;
  t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  t.mock.method(f.bot.api, 'sendMessage', async (...args) => {
    if (String(args[1]).includes('⏱')) { footerAttempts++; throw Error('synthetic footer failure'); }
    return sendMessage(...args);
  });
  await f.message('Отправь файл');
  await until(() => f.mediaSends.length === 1 && footerAttempts === 1, 'file and rejected footer');
  await f.bot.stop();
  assert.ok(!f.messages.some(text => /Ответ не пришёл|❌ Ошибка/.test(text)));
  assert.ok(errors.some(text => text.includes('attachment footer delivery failed')));
});

test('a partially delivered media queue retains the existing visible failure notice', async t => {
  const f = await fixture(t, async () => ({ ok: true, text: '[ФАЙЛ: missing.txt]\n[ФОТО: present.png]' }), { overlay: false });
  await fs.writeFile(path.join(f.workspace, 'present.png'), 'synthetic image');
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  await f.message('Отправь файлы');
  await until(() => f.mediaSends.length === 1 && f.messages.some(text => text.includes('Ответ не пришёл')), 'partial delivery');
  await f.bot.stop();
  assert.equal(f.mediaSends[0].method, 'sendPhoto');
  assert.ok(f.messages.some(text => text.includes('Ответ не пришёл')));
  assert.ok(errors.some(text => text.includes('send_media failed')));
});

test('a genuinely empty answer keeps the existing fallback', async t => {
  const f = await fixture(t, async () => ({ ok: true, text: '' }), { overlay: false });
  await f.message('Пустой ответ');
  await until(() => f.messages.some(text => text.includes('Ответ не пришёл')), 'empty answer');
  assert.equal(f.mediaSends.length, 0);
});

test('text and plan buttons remain visible when an attachment is also present', async t => {
  const f = await fixture(t, async () => ({ ok: true, text: 'Готово.\n[ФАЙЛ: plan.txt]\n[КНОПКИ: plan]' }), { overlay: false });
  await fs.writeFile(path.join(f.workspace, 'plan.txt'), 'synthetic attachment');
  await f.message('Покажи план');
  await until(() => f.mediaSends.length === 1, 'plan attachment');
  assert.ok(f.messages.some(text => text.includes('Готово.')));
  assert.ok(f.messageOptions.some(options => options?.reply_markup?.inline_keyboard?.length));
});

test('provider error text is preserved even alongside an attachment', async t => {
  const f = await fixture(t, async () => ({ ok: false, text: '[ФАЙЛ: partial.txt]',
    result: { errorDisplay: { before: 'Диагностика провайдера. ', after: '' } } }), { overlay: false });
  await fs.writeFile(path.join(f.workspace, 'partial.txt'), 'synthetic attachment');
  await f.message('Проверь ошибку');
  await until(() => f.mediaSends.length === 1, 'partial attachment');
  assert.ok(f.messages.some(text => text.includes('Диагностика провайдера.')));
});
