/**
 * Quiet saved-prompt trim + owner-digest delivery without the publish banner.
 * Contract: ops/pult/tz-quiet-owner-trim.md + digests from tz-tg-html-fence-unwrap.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { quietResult, trimQuietOwnerText } from '../src/autonomy/prompt-turn.mjs';
import { deliverSavedPrompt, trimOwnerDigestText } from '../src/autonomy/prompt-delivery.mjs';

test('quietResult treats exact, trailing and glued silence markers as quiet', () => {
  assert.equal(quietResult('[NOTHING_TO_REPORT]'), true);
  assert.equal(quietResult('…ход мысли…\n[NOTHING_TO_REPORT]'), true);
  assert.equal(quietResult('читаю регламент[NOTHING_TO_REPORT]'), true);
  assert.equal(quietResult('Диагностика.\n```text\n[NOTHING_TO_REPORT]'), false);
  assert.equal(quietResult('обычный отчёт'), false);
});

test('trimQuietOwnerText keeps from the first owner marker and wraps found-count lines', () => {
  assert.equal(
    trimQuietOwnerText('Читаю…\n🟢 От тебя ничего не нужно\nНашёл 1 поводов…\n- Title'),
    '🟢 От тебя ничего не нужно\nНашёл 1 поводов…\n- Title',
  );
  assert.equal(
    trimQuietOwnerText('Проверяю…\n🔴 Нужно от тебя: лента мертва'),
    '🔴 Нужно от тебя: лента мертва',
  );
  assert.equal(
    trimQuietOwnerText('думаю…\nНашёл 2 поводов для публикации\n- A'),
    '🟢 От тебя ничего не нужно\nНашёл 2 поводов для публикации\n- A',
  );
  assert.equal(trimQuietOwnerText('просто текст без маркера'), 'просто текст без маркера');
});

test('trimOwnerDigestText drops thinking before HTML or traffic-light digests', () => {
  assert.equal(
    trimOwnerDigestText('Собираю данные из pult…\n<b>Быстрые деньги · 16.11</b>\nAsk: пусто'),
    '<b>Быстрые деньги · 16.11</b>\nAsk: пусто',
  );
  assert.equal(
    trimOwnerDigestText('Собираю данные…\n```html\n<b>Быстрые деньги · 16.11</b>\nAsk: пусто\n```'),
    '<b>Быстрые деньги · 16.11</b>\nAsk: пусто',
  );
  assert.equal(
    trimOwnerDigestText('преамбула\n🟢 От тебя ничего не нужно\nхвост'),
    '🟢 От тебя ничего не нужно\nхвост',
  );
  assert.equal(trimOwnerDigestText('обычный отчёт без digest-маркера'), 'обычный отчёт без digest-маркера');
  assert.equal(
    trimOwnerDigestText('вот скрипт:\n```js\nconst x = 1\n```'),
    'вот скрипт:\n```js\nconst x = 1\n```',
  );
});

test('deliverSavedPrompt skips the publish banner for quietOwner and HTML digests', async () => {
  const sent = [];
  const api = {
    async sendMessage(chat, text) {
      sent.push({ chat, text });
    },
  };
  const signal = AbortSignal.timeout(5_000);

  await deliverSavedPrompt(api, 1, {
    status: 'ok',
    quietOwner: true,
    text: '🟢 От тебя ничего не нужно\nНашёл 1 поводов…\n- Title',
  }, signal);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^🟢/);
  assert.doesNotMatch(sent[0].text, /Ничего не опубликовано/);

  sent.length = 0;
  await deliverSavedPrompt(api, 1, {
    status: 'ok',
    text: 'Собираю данные…\n<b>Быстрые деньги</b>\nAsk: пусто',
  }, signal);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^<b>Быстрые деньги<\/b>/);
  assert.doesNotMatch(sent[0].text, /Ничего не опубликовано|Собираю данные/);

  sent.length = 0;
  await deliverSavedPrompt(api, 1, {
    status: 'ok',
    text: 'Длинный non-quiet отчёт без digest-маркера',
  }, signal);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Ничего не опубликовано/);
  assert.match(sent[1].text, /Длинный non-quiet отчёт/);
});
