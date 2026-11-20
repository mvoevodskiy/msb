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

test('short response removes the thinking status and sends a new formatted message', async () => {
  const { ctx, calls } = fixture();
  const result = await deliverTurnResponse(ctx, 101, '**Готово**: `a < b`', {
    elapsedMs: 2345, costUsd: 0.0124, context: { contextTokens: 150, contextWindow: 1000 },
  });
  assert.deepEqual(result, { method: 'send', messages: 1 });
  assert.deepEqual(calls.map(call => call.method), ['delete', 'send']);
  assert.deepEqual(calls[0], { method: 'delete', chatId: 42, messageId: 101 });
  assert.equal(calls[1].text, '<b>Готово</b>: <code>a &lt; b</code>\n\n<blockquote>⏱ 2.3s · $0.012 · ○○○ 15%</blockquote>');
  assert.equal(calls[1].options.parse_mode, 'HTML');
  assert.equal(calls[1].options.message_thread_id, 7);
  assert.notEqual(calls[1].options.disable_notification, true);
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

test('Telegram-HTML fences unwrap to markup; ordinary code fences stay escaped', () => {
  assert.equal(renderResponseHtml('```html\n<b>A</b>\nAsk: пусто\n```'), '<b>A</b>\nAsk: пусто');
  assert.equal(
    renderResponseHtml('Собираю данные…\n```html\n<b>A</b>\n```\n'),
    'Собираю данные…\n<b>A</b>\n',
  );
  assert.equal(renderResponseHtml('```\n<b>Быстрые деньги</b>\n```'), '<b>Быстрые деньги</b>');
  assert.equal(renderResponseHtml('```js\nconst x = 1\n```'), '<pre><code>const x = 1</code></pre>');
  assert.equal(renderResponseHtml('<b>A</b>'), '<b>A</b>');
  assert.equal(
    renderResponseHtml('```text\n<b>literal tags</b>\n```'),
    '<pre><code>&lt;b&gt;literal tags&lt;/b&gt;</code></pre>',
  );
});

test('code examples containing HTML code/pre tags reach Telegram without placeholder loss', async () => {
  // Old source: readable blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11,
  // _zA lines 3103-3144 restores code blocks, inline code and HTML separately.
  // A single new-core replacement used to strand nested NUL placeholders.
  const examples = [
    ['```text\n<code>VISIBLE &amp; @raw main.py</code>\n```', '<code>VISIBLE &amp; @raw main.py</code>'],
    ['```js\nconst html = "<pre>VISIBLE</pre>";\n```', 'const html = "<pre>VISIBLE</pre>";'],
    ['`<code>VISIBLE</code>`', '<code>VISIBLE</code>'],
  ];
  for (const [input, expected] of examples) {
    const { ctx, calls } = fixture();
    await deliverTurnResponse(ctx, 101, input);
    const sent = calls.filter(call => call.method === 'send');
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /\0/, 'Internal placeholders must never reach Telegram.');
    assert.equal(plain(sent[0].text), expected, 'Source markup inside code is literal text.');
    assertBalanced(sent[0].text);
  }
});

test('HTML code regions and unwrapped HTML fences retain their own literal boundaries', () => {
  assert.equal(
    renderResponseHtml('<pre>```text\n<code>VISIBLE</code>\n```</pre>'),
    '<pre>```text\n&lt;code&gt;VISIBLE&lt;/code&gt;\n```</pre>',
  );
  assert.equal(
    renderResponseHtml('```html\n<b>Пример</b> <code>**literal** @raw main.py</code>\n```'),
    '<b>Пример</b> <code>**literal** @raw main.py</code>',
  );
  assert.equal(
    renderResponseHtml('<code>before</code> и `"<pre>inside</pre>"` и <code>after</code>'),
    '<code>before</code> и <code>"&lt;pre&gt;inside&lt;/pre&gt;"</code> и <code>after</code>',
  );
});

test('literal backticks inside Telegram HTML code do not close the outer fence', async () => {
  for (const opening of ['```html', '```']) {
    const input = [
      opening, '<b>Пример</b>', '<code>inline ``` code</code>', '<pre><code>literal ``` here</code></pre>', '```',
      '```js', 'const html = "<code>text</code>";', '```',
    ].join('\n');
    const { ctx, calls } = fixture();
    await deliverTurnResponse(ctx, 101, input);
    const sent = calls.filter(call => call.method === 'send');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, [
      '<b>Пример</b>', '<code>inline ``` code</code>', '<pre><code>literal ``` here</code></pre>',
      '<pre><code>const html = "&lt;code&gt;text&lt;/code&gt;";</code></pre>',
    ].join('\n'));
    assertBalanced(sent[0].text);
  }
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

test('delete failure does not prevent short or long answer delivery', async () => {
  const short = fixture({ deleteError: new Error('already deleted') });
  await deliverTurnResponse(short.ctx, 101, 'Ответ', { elapsedMs: 1000 });
  assert.deepEqual(short.calls.map(call => call.method), ['delete', 'send']);
  assert.equal(short.calls[1].text, 'Ответ\n\n<blockquote>⏱ 1.0s</blockquote>');
  assert.equal(short.calls[1].options.message_thread_id, 7);
  const long = fixture({ deleteError: new Error('already deleted') });
  await deliverTurnResponse(long.ctx, 101, 'x'.repeat(5000));
  assert.equal(long.calls.filter((call) => call.method === 'send').map((call) => call.text).join(''), 'x'.repeat(5000));
});

test('fallback failures only attempt to delete the supplied bot status, never the user message', async () => {
  const { ctx, calls } = fixture({
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
