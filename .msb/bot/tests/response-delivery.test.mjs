import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverTurnResponse, formatTurnFooter, renderResponseHtml } from '../src/telegram/response.mjs';

function fixture({ editError, deleteError, sendError } = {}) {
  const calls = [];
  const ctx = {
    chat: { id: 42 }, message: { message_id: 501, message_thread_id: 7 },
    api: {
      async editMessageText(chatId, messageId, text, options) {
        calls.push({ method: 'edit', chatId, messageId, text, options });
        if (editError) throw editError;
      },
      async deleteMessage(chatId, messageId) {
        calls.push({ method: 'delete', chatId, messageId });
        if (deleteError) throw deleteError;
      },
    },
    async reply(text, options) {
      calls.push({ method: 'send', text, options });
      if (sendError && options.parse_mode) throw sendError;
    },
  };
  return { ctx, calls };
}

function plain(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
function assertBalanced(html) {
  const stack = [];
  for (const [, slash, name] of html.matchAll(/<(\/?)([a-z-]+)(?:\s[^>]*)?>/g)) {
    if (slash) assert.equal(stack.pop(), name, `Mismatched tag in ${html.slice(0, 80)}`);
    else stack.push(name);
  }
  assert.deepEqual(stack, []);
}

test('short response edits the original status with Markdown and the compact old footer', async () => {
  const { ctx, calls } = fixture();
  const result = await deliverTurnResponse(ctx, 101, '**Готово**: `a < b`', {
    elapsedMs: 2345, costUsd: 0.0124, context: { contextTokens: 150, contextWindow: 1000 },
  });
  assert.deepEqual(result, { method: 'edit', messages: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messageId, 101);
  assert.equal(calls[0].text, '<b>Готово</b>: <code>a &lt; b</code>\n\n<blockquote>⏱ 2.3s · $0.012 · ○○○ 15%</blockquote>');
  assert.equal(calls[0].options.parse_mode, 'HTML');
  assert.equal(calls[0].chatId, 42);
  assert.equal(calls[0].options.message_thread_id, undefined); // Editing already identifies its topic by message ID.
  assert.ok(!calls.some((call) => call.text === '✅'));
});

test('footer omits unknown/zero telemetry, hides small context and clamps 100%', () => {
  assert.equal(formatTurnFooter(), '');
  assert.equal(formatTurnFooter({ elapsedMs: NaN, costUsd: 2 }), '');
  assert.equal(formatTurnFooter({ elapsedMs: 1000 }), '\n\n<blockquote>⏱ 1.0s</blockquote>');
  for (const costUsd of [undefined, NaN, Infinity, -1, 0, 0.0009]) {
    assert.doesNotMatch(formatTurnFooter({ elapsedMs: 0, costUsd }), /\$/);
  }
  assert.match(formatTurnFooter({ elapsedMs: 1000, costUsd: 0.001 }), /\$0\.001/);
  assert.doesNotMatch(formatTurnFooter({ elapsedMs: 1000, context: { contextTokens: 4, contextWindow: 100 } }), /%/);
  assert.match(formatTurnFooter({ elapsedMs: 1000, context: { contextTokens: 5, contextWindow: 100 } }), /○○○ 5%/);
  assert.match(formatTurnFooter({ elapsedMs: 1000, context: { contextTokens: 900, contextWindow: 100 } }), /●●● 100%/);
  assert.doesNotMatch(formatTurnFooter({ elapsedMs: 1000, context: { contextTokens: 10, contextWindow: 0 } }), /%/);
});

test('HTML and common Markdown preserve text and escape unsupported or unsafe markup', () => {
  assert.equal(renderResponseHtml('<b>HTML &amp; текст</b> <value>'), '<b>HTML &amp; текст</b> &lt;value&gt;');
  assert.equal(renderResponseHtml('[ссылка](https://example.test/?a=1&b=2)'), '<a href="https://example.test/?a=1&amp;b=2">ссылка</a>');
  assert.equal(renderResponseHtml('```js\nconst x = "<b>";\n```'), '<pre><code>const x = "&lt;b&gt;";</code></pre>');
  assert.equal(renderResponseHtml('<code>**literal** &amp; &lt;b&gt;</code>'), '<code>**literal** &amp; &lt;b&gt;</code>');
  assert.equal(renderResponseHtml('<pre><code>**literal**</code></pre>'), '<pre><code>**literal**</code></pre>');
  const unsafe = renderResponseHtml('<a href="javascript:bad()">text</a><script>bad</script>');
  assert.doesNotMatch(unsafe, /<a\b|<script>/);
  assertBalanced(renderResponseHtml('<b>unfinished'));
});

test('old list, mention and filename presentation matches the vendor golden forms', () => {
  assert.equal(
    renderResponseHtml('- @alice проверь report.md\n— **Обзор** и config.yaml\n• `@raw main.py`'),
    '[x] <code>@alice</code> проверь <code>report.md</code>\n[x] <b>Обзор</b> и <code>config.yaml</code>\n[x] <code>@raw main.py</code>',
  );
  assert.equal(
    renderResponseHtml('```text\n- @literal index.js\n```\n<pre>• @other settings.json</pre>\n<code>@raw main.py</code>'),
    '<pre><code>- @literal index.js</code></pre>\n<pre>• @other settings.json</pre>\n<code>@raw main.py</code>',
  );
  assert.equal(
    renderResponseHtml('<a href="https://example.test/app.js">@alice app.js</a> и x@example.com, src/main.py'),
    '<a href="https://example.test/app.js"><code>@alice</code> <code>app.js</code></a> и x@example.com, src/main.py',
  );
});

test('long HTML/Unicode responses delete status, preserve all text, and append footer only to the last chunk', async () => {
  const { ctx, calls } = fixture();
  const text = 'аб😀 & < > '.repeat(1000);
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const result = await deliverTurnResponse(ctx, 101, `<b>${escaped}</b>`, { elapsedMs: 1200 });
  assert.equal(calls[0].method, 'delete');
  const sent = calls.filter((call) => call.method === 'send');
  assert.equal(sent.length, result.messages);
  assert.ok(sent.length > 1);
  for (const [index, call] of sent.entries()) {
    assert.ok(call.text.length <= 4000);
    assert.equal(call.text.isWellFormed(), true);
    assertBalanced(call.text);
    assert.equal(call.options.message_thread_id, 7);
    assert.equal(call.text.includes('<blockquote>⏱'), index === sent.length - 1);
  }
  const body = sent.map((call) => plain(call.text.replace(/\n\n<blockquote>⏱[^<]*<\/blockquote>$/, ''))).join('');
  assert.equal(body, text);
});

test('edit failure falls back to send; not-modified is successful; delete failure does not lose a long reply', async () => {
  const failed = fixture({ editError: new Error('message to edit not found') });
  await deliverTurnResponse(failed.ctx, 101, 'Ответ', { elapsedMs: 1000 });
  assert.deepEqual(failed.calls.map((call) => call.method), ['edit', 'delete', 'send']);
  assert.deepEqual(failed.calls[1], { method: 'delete', chatId: 42, messageId: 101 });
  assert.equal(failed.calls[2].text, failed.calls[0].text);
  assert.equal(failed.calls[2].options.message_thread_id, 7);
  const unchanged = fixture({ editError: new Error('Bad Request: message is not modified') });
  await deliverTurnResponse(unchanged.ctx, 101, 'Ответ');
  assert.deepEqual(unchanged.calls.map((call) => call.method), ['edit']);
  const long = fixture({ deleteError: new Error('already deleted') });
  await deliverTurnResponse(long.ctx, 101, 'x'.repeat(5000));
  assert.equal(long.calls.filter((call) => call.method === 'send').map((call) => call.text).join(''), 'x'.repeat(5000));
});

test('fallback failures only attempt to delete the supplied bot status, never the user message', async () => {
  const { ctx, calls } = fixture({
    editError: new Error('message cannot be edited'),
    deleteError: new Error('status already deleted'),
    sendError: new Error('fixture connection failure'),
  });
  await assert.rejects(deliverTurnResponse(ctx, 101, 'Ответ'), /fixture connection failure/);
  assert.deepEqual(calls.filter((call) => call.method === 'delete'), [{ method: 'delete', chatId: 42, messageId: 101 }]);
  assert.ok(!calls.some((call) => call.method === 'delete' && call.messageId === ctx.message.message_id));
});

test('Telegram HTML parse rejection falls back to plain text without losing the answer', async () => {
  const { ctx, calls } = fixture({ sendError: new Error("can't parse entities") });
  await deliverTurnResponse(ctx, null, '**Ответ** <literal> 😀', { elapsedMs: 1000 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].text, 'Ответ <literal> 😀\n\n⏱ 1.0s');
  assert.equal(calls[1].options.parse_mode, undefined);
});
