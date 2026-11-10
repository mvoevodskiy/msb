/** Original final marker/buttons → one existing FIFO worker, synthetic transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState } from '../src/state.mjs';
import { deliverTurnResponse } from '../src/telegram/response.mjs';
const keyboards = {
  control: [[['✔ Вносить', 'plan:approve'], ['✖ Пропустить', 'plan:skip']], [['💬 Комментарий', 'plan:comment']]],
  plan: [[['✔ Продолжай', 'plan:approve'], ['✖ Стоп', 'plan:reject']], [['💬 Комментарий', 'plan:comment']]],
  approve: [[['✓ Один раз', 'plan:approve'], ['☑ Всегда', 'plan:always'], ['✕ Нет', 'plan:reject']]],
};
const shape = keyboard => keyboard?.inline_keyboard.map(row => row.map(b => [b.text, b.callback_data]));
const pause = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('Fixture condition timed out'); }

for (const pattern of ['control', 'plan', 'approve']) test(`final ${pattern} marker creates the original separate answer card and buttons`, async t => {
  const f = await fixture(t, async () => ({ ok: true, text: `Готовый план\n[КНОПКИ: ${pattern}]` }));
  await f.message('synthetic task');
  await until(() => [...f.messages, ...f.edits].some(text => text.includes('Готовый план')));
  await f.bot.stop();
  assert.ok(f.deleted.includes(1), 'delete the thinking status, as old sendPlanMessage did');
  assert.equal(f.edits.some(text => text.includes('Готовый план')), false, 'the final card is a new message');
  assert.match(f.messages.at(-1), /^Готовый план\n\n<blockquote>⏱/);
  assert.doesNotMatch(f.messages.at(-1), /КНОПКИ/);
  assert.deepEqual(shape(f.messageOptions.at(-1)?.reply_markup), keyboards[pattern]);
});

for (const [text, pattern] of [['Правка готова. ✔ вносить / ✖ пропустить?', 'control'], ['План готов. Делаем? ✔ или ✖', 'plan']]) test(`old fallback phrase produces ${pattern} buttons`, async t => {
  const f = await fixture(t, async () => ({ ok: true, text }));
  await f.message('synthetic task');
  await until(() => [...f.messages, ...f.edits].some(value => value.includes(text)));
  await f.bot.stop();
  assert.ok(f.messages.at(-1).startsWith(text), 'fallback phrase remains visible');
  assert.deepEqual(shape(f.messageOptions.at(-1)?.reply_markup), keyboards[pattern]);
});

for (const [action, prompt] of [
  ['approve', '✔ Продолжай выполнение.'], ['always', '☑ Разрешаю это действие всегда. Продолжай.'],
  ['skip', '✖ Пропусти это изменение, продолжай дальше.'],
]) test(`${action} removes only the clicked card keyboard and queues the old exact instruction`, async t => {
  const calls = [], f = await fixture(t, async opts => { calls.push(opts.prompt); return { ok: true, text: 'Продолжение готово' }; });
  const before = (await loadState()).state, store = await fs.readFile(f.storeFile, 'utf8');
  await f.callback(`plan:${action}`, 42, { messageId: 77 });
  assert.equal(f.messages.some(text => text.includes('Обработчик подтверждения')), false, 'no placeholder response');
  await until(() => calls.length === 1); await f.bot.stop();
  assert.deepEqual(calls, [prompt]);
  assert.deepEqual(f.markupEdits, [{ chatId: 42, messageId: 77, options: { reply_markup: undefined } }]);
  assert.deepEqual((await loadState()).state, before, 'always is not a persistent grant or session reset');
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
});

test('reject retains old cancellation text and starts no model turn or permission change', async t => {
  const calls = [], f = await fixture(t, async opts => { calls.push(opts.prompt); return { ok: true, text: 'unexpected' }; });
  const before = (await loadState()).state;
  await f.callback('plan:reject', 42, { messageId: 77 }); await f.bot.stop();
  assert.deepEqual(calls, []);
  assert.equal(f.messages.at(-1), '✖️ Задача отменена. Напиши что изменить.');
  assert.equal(f.markupEdits.at(-1)?.messageId, 77);
  assert.deepEqual((await loadState()).state, before);
});

test('comment consumes exactly the next ordinary text and routes it through the same queue', async t => {
  const calls = [], f = await fixture(t, async opts => { calls.push(opts.prompt); return { ok: true, text: 'Комментарий принят' }; });
  await f.callback('plan:comment', 42, { messageId: 77 });
  assert.equal(f.messages.at(-1), 'Напиши комментарий — агент учтёт его:');
  await f.message('измени второй шаг');
  await until(() => calls.length === 1 && f.edits.some(text => text.startsWith('Комментарий принят')));
  await f.message('обычная следующая задача');
  await until(() => calls.length === 2); await f.bot.stop();
  assert.deepEqual(calls, ['✖ Не согласен. Комментарий: измени второй шаг', 'обычная следующая задача']);
  assert.ok(f.markupEdits.every(edit => edit.messageId === 77));
});

test('plan continuation shares active-turn lock and /stop queue cancellation', async t => {
  const gate = pause(), entered = pause(), calls = [];
  const f = await fixture(t, async opts => {
    calls.push(opts.prompt); entered.resolve(); await gate.promise;
    return { ok: false, error: 'aborted', text: 'Остановлено.' };
  });
  await f.message('долгий ход'); await entered.promise;
  await f.callback('plan:approve');
  assert.equal(calls.length, 1, 'no independent confirmation runner');
  await f.message('/stop'); gate.resolve(); await f.bot.stop();
  assert.deepEqual(calls, ['долгий ход']);
  assert.ok(f.edits.includes('Моя остановочка ✋🏽⛔️'));
  assert.equal(f.markupEdits.length, 1);
});

test('tool/text events and aborted final output never create a new approval keyboard', async t => {
  const gate = pause(), entered = pause();
  const f = await fixture(t, async ({ onStatus, signal }) => {
    onStatus({ kind: 'text', preview: '[КНОПКИ: plan]' }); entered.resolve(); await gate.promise;
    return { ok: true, error: signal.aborted ? 'aborted' : undefined, text: '[КНОПКИ: plan]' };
  });
  await f.message('долгий ход'); await entered.promise;
  assert.equal(f.messageOptions.some(opts => opts?.reply_markup), false);
  await f.message('/stop'); gate.resolve(); await f.bot.stop();
  assert.equal(f.messageOptions.some(opts => opts?.reply_markup), false);
  assert.ok(f.edits.includes('Моя остановочка ✋🏽⛔️'));
});

test('owner guard rejects confirmation callbacks without changing markup or running a turn', async t => {
  const calls = [], f = await fixture(t, async opts => { calls.push(opts.prompt); return { ok: true, text: 'unexpected' }; });
  await f.callback('plan:approve', 43); await f.bot.stop();
  assert.deepEqual(calls, []); assert.deepEqual(f.markupEdits, []);
});

test('long plan HTML fallback keeps keyboard/footer only on the last chunk', async () => {
  const sent = [], deleted = [];
  const ctx = { chat: { id: 42 }, message: { message_thread_id: 7 }, api: { deleteMessage: async (_chat, id) => deleted.push(id) },
    reply: async (text, opts) => { if (opts.parse_mode) throw Error('cannot parse entities'); sent.push({ text, opts }); } };
  await deliverTurnResponse(ctx, 101, 'План '.repeat(1100) + '[КНОПКИ: plan]', { elapsedMs: 1000 });
  assert.deepEqual(deleted, [101]); assert.ok(sent.length > 1);
  assert.equal(sent.map(m => m.text.replace(/\n\n⏱ 1.0s$/, '')).join(''), 'План '.repeat(1100).trimEnd());
  for (const [i, call] of sent.entries()) {
    const last = i === sent.length - 1;
    assert.equal(call.opts.message_thread_id, 7);
    assert.equal(call.opts.reply_markup !== undefined, last);
    if (last) assert.deepEqual(shape(call.opts.reply_markup), keyboards.plan);
    assert.equal(call.text.includes('⏱'), last);
  }
});


test('unknown/prototype plan callbacks do not create a hidden continuation', async t => {
  const calls = [], f = await fixture(t, async opts => { calls.push(opts.prompt); return { ok: true, text: 'ready' }; });
  for (const action of ['constructor', 'toString', '__proto__', 'unknown-fixture']) await f.callback(`plan:${action}`);
  await f.message('sentinel ordinary input');
  await until(() => calls.some(p => typeof p === 'string' && p.includes('sentinel ordinary input')));
  await f.bot.stop();
  assert.deepEqual(calls, ['sentinel ordinary input']);
});

test('infrastructure error containing a marker is a plain error notice, not an approval card', async t => {
  const f = await fixture(t, async () => { throw Error('fixture error [КНОПКИ: plan]'); });
  await f.message('synthetic task');
  await until(() => f.edits.some(text => text.includes('fixture error')));
  await f.bot.stop();
  assert.equal(f.messageOptions.some(opts => opts?.reply_markup), false);
  assert.match(f.edits.at(-1), /❌ Ошибка: fixture error \[КНОПКИ: plan\]/);
});

test('callback continuation keeps its topic through queue status and final response', async t => {
  const calls = [], f = await fixture(t, async opts => { calls.push(opts.prompt); return { ok: true, text: 'topic response' }; });
  await f.callback('plan:approve', 42, { threadId: 7 });
  await until(() => f.edits.some(text => text.startsWith('topic response'))); await f.bot.stop();
  assert.deepEqual(calls, ['✔ Продолжай выполнение.']);
  assert.ok(f.messageOptions.some(opts => opts?.message_thread_id === 7));
});

test('plan comment is consumed only in its originating chat; other text retains ordinary routing', async t => {
  const calls = [], f = await fixture(t, async opts => { calls.push(opts.prompt); return { ok: true, text: 'ready' }; });
  await f.callback('plan:comment');
  await f.bot.handleUpdate({ message: { message_id: 7, from: { id: 42 }, chat: { id: 43 }, text: 'другой чат' } });
  await until(() => f.edits.some(text => text.startsWith('ready')));
  await f.message('мой комментарий');
  await until(() => calls.length === 2); await f.bot.stop();
  assert.deepEqual(calls, ['другой чат', '✖ Не согласен. Комментарий: мой комментарий']);
});
