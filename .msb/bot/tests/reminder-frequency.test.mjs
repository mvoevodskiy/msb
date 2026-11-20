/**
 * [Legacy frequency brake](../src/autonomy/reminder-frequency.mjs) through the
 * scheduler and owner callback. Old source and retrieval are in
 * [the contract](./reference/parity-autonomy-contract.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initial, min, owner, at, every, cron, record, profile } from './helpers/recurring-reminder-fixture.mjs';

const subject = id => 'autonomy-cron:' + id + ':frequency';
const labels = ['Раз в час', 'Оставить как есть', 'Выключить задачу'];
const question = '🧭 Решение';
const producer = 'autonomy/pre-turn-brakes';

function questions(f) {
  return f.messages.flatMap((text, index) => text.startsWith(question)
    ? [{ text, messageId: index + 1, buttons: f.messageOptions[index].reply_markup.inline_keyboard }] : []);
}

async function choose(f, card, option, uid = 42, chatId = owner, messageId = card.messageId) {
  await f.callback(card.buttons[option][0].callback_data, uid, { chatId, messageId });
}

const lastAck = f => f.callbackAnswers.at(-1)?.[0]?.text;

test('the old question appears before due and only once per fast local action even with two scheduler passes', async t => {
  const rows = [
    record('interval <&>', every(59), { lastRunAt: at(initial) }),
    record('cron', cron('5,55 * * * *')),
    record('boundary', every(60), { lastRunAt: at(initial) }),
    record('unknown', cron('5-20/5 * * * *')),
    record('future', { kind: 'once', at: at(initial + 60 * min) }),
    record('off', every(10), { enabled: false, disabledReason: 'owner' }),
    record('killed', every(10), { budget: { killSwitch: true } }),
    record('native', every(10), { runner: 'oc' }),
    record('mapped', every(10)),
  ];
  const f = await profile(t, rows);
  await fs.writeFile(path.join(f.autonomy, 'cron-jobs.json'), '{"mapped":{"jobId":"fixture-job"}}');
  const other = f.makeScheduler();
  t.after(() => other.stop());
  await Promise.all([f.scheduler.tickNow(), other.tickNow()]);
  await f.advance(initial + min);
  const cards = questions(f);
  assert.equal(cards.length, 2);
  assert.match(cards[0].text, /^🧭 Решение\n\n<b>Фоновая задача «Сохранено interval &lt;&amp;&gt;» срабатывает слишком часто<\/b>\n\n/);
  assert.match(cards[0].text, /Сейчас она идёт каждые 59 мин, а нижняя граница 60 мин\. Каждый запуск стоит денег, поэтому я снял её с расписания и жду твоего решения\. Выбор запомню и больше спрашивать не буду\./);
  assert.ok(cards[0].text.endsWith('<i>' + producer + '</i>'));
  assert.match(cards[1].text, /каждые 10 мин/);
  assert.deepEqual(cards[0].buttons.map(row => row.map(button => button.text)), labels.map(label => [label]));
  assert.match(cards[0].buttons[0][0].callback_data, /^dc:[0-9a-f]{8}:hourly$/);
  assert.match(cards[0].buttons[1][0].callback_data, /^dc:[0-9a-f]{8}:keep_as_is$/);
  assert.match(cards[0].buttons[2][0].callback_data, /^dc:[0-9a-f]{8}:turn_off$/);
  assert.deepEqual(f.sent.map(row => row.chat), [owner, owner]);
  const after = await f.rows();
  assert.deepEqual(after.slice(0, 2), rows.slice(0, 2).map(row => ({ ...row, disabledReason: 'frequency' })));
  assert.deepEqual(after.slice(2), rows.slice(2));
  const journal = new Map((await f.runs()).map(row => [row.actionId, [row.status, row.costUsd]]));
  assert.equal((await f.runs()).length, 2);
  assert.deepEqual(journal.get('interval <&>'), ['skipped', 0]);
  assert.deepEqual(journal.get('cron'), ['skipped', 0]);
  const pending = Object.values((await f.decisionBook()).pending);
  assert.deepEqual(pending.map(row => row.subject), rows.slice(0, 2).map(row => subject(row.id)));
});

test('a legacy pending Keep stays scoped to its owner and message and survives replay, STOP and restart', async t => {
  const entry = record('legacy', every(15), { disabledReason: 'frequency' });
  const f = await profile(t, [entry]);
  const shortId = '00a1b2c3';
  const legacy = { shortId, msgId: 55, subject: subject(entry.id), sentAt: at(initial - min),
    title: 'Фоновая задача «Сохранено legacy» срабатывает слишком часто',
    body: 'Сейчас она идёт каждые 15 мин.', producedBy: producer,
    options: ['hourly', 'keep_as_is', 'turn_off'].map((value, index) => ({ value, label: labels[index] })) };
  const duplicate = { ...legacy, shortId: '11a1b2c3', msgId: 57 };
  const original = { pending: { [shortId]: legacy, [duplicate.shortId]: duplicate, '00000000': { subject: 'another-card' } },
    decisions: { another: { value: 'unchanged' } }, retained: 1 };
  await fs.writeFile(f.decisionFile, JSON.stringify(original));
  await f.scheduler.tickNow();
  assert.equal(questions(f).length, 0);
  const options = { chatId: owner, messageId: legacy.msgId };
  const data = 'dc:' + shortId + ':keep_as_is';
  await f.callback(data, 43, options);
  await f.callback(data, 42, { ...options, chatId: 42 });
  await f.callback(data, 42, { ...options, messageId: 56 });
  await f.callback('dc:' + shortId + ':not_a_choice', 42, options);
  assert.equal(lastAck(f), 'Карточка устарела');
  assert.deepEqual(await f.decisionBook(), original);
  const stop = path.join(f.autonomy, 'STOP');
  await fs.writeFile(stop, 'fixture stop');
  await f.callback(data, 42, options);
  assert.equal(lastAck(f), 'Решено: Оставить как есть');
  assert.match(f.edits.at(-1), /Решено: Оставить как есть$/);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard, []);
  const decided = await f.decisionBook();
  assert.deepEqual(decided.decisions[subject(entry.id)], {
    subject: subject(entry.id), value: 'keep_as_is', label: labels[1], decidedAt: at(initial),
    producedBy: producer, cardShortId: shortId,
  });
  assert.deepEqual(decided.pending, { [duplicate.shortId]: duplicate, '00000000': original.pending['00000000'] });
  assert.deepEqual(decided.decisions.another, original.decisions.another);
  assert.equal(decided.retained, 1);
  await f.callback('dc:' + shortId + ':hourly', 42, options);
  assert.equal(lastAck(f), 'Уже решено: Оставить как есть');
  await f.callback('dc:' + duplicate.shortId + ':turn_off', 42, { chatId: owner, messageId: duplicate.msgId });
  assert.equal(lastAck(f), 'Уже решено: Оставить как есть');
  assert.deepEqual(await f.decisionBook(), decided);
  await f.scheduler.stop();
  const restarted = f.makeScheduler();
  t.after(() => restarted.stop());
  await restarted.tickNow();
  assert.deepEqual(await f.rows(), [entry]);
  assert.equal(f.deliveries().length, 0);
  await fs.unlink(stop);
  await restarted.tickNow();
  assert.deepEqual(f.deliveries(), [{ chat: owner, text: '⏰ Дословно legacy' }]);
  assert.match(f.messages.at(-2), /ограничение \(частота\) снято/);
  assert.deepEqual((await f.runs()).map(row => row.status), ['skipped', 'ok']);
});

test('hourly preserves the held state for the old apply tick and then fires at the start of the local hour', async t => {
  const entry = record('hourly', every(15), { lastRunAt: at(initial - 30 * min), lastStatus: 'error',
    lastOutcome: 'engine_error', lastError: 'retained by the old reschedule', nextFireAt: at(initial + min),
    pendingReschedule: { original: true } });
  const f = await profile(t, [entry]);
  await f.scheduler.tickNow();
  await choose(f, questions(f)[0], 0);
  assert.equal(lastAck(f), 'Решено: Раз в час');
  assert.deepEqual(await f.rows(), [{ ...entry, disabledReason: 'frequency' }]);
  await f.scheduler.tickNow();
  const [applied] = await f.rows();
  assert.deepEqual(applied.trigger, cron('0 * * * *'));
  assert.equal(applied.disabledReason, 'frequency');
  assert.equal(applied.lastError, entry.lastError);
  assert.equal(applied.retained, entry.retained);
  for (const key of ['lastRunAt', 'lastStatus', 'lastOutcome', 'nextFireAt', 'pendingReschedule']) {
    assert.equal(Object.hasOwn(applied, key), false, key);
  }
  assert.equal(f.deliveries().length, 0);
  assert.match(f.messages.at(-1), /теперь идёт раз в час, в начале каждого часа\. Сейчас верну её в расписание/);
  await f.advance(initial + min);
  assert.equal((await f.rows())[0].disabledReason, undefined);
  assert.equal(f.deliveries().length, 0);
  await f.advance(initial + 60 * min);
  assert.equal(f.deliveries().length, 1);
  assert.deepEqual((await f.runs()).map(row => row.status), ['skipped', 'skipped', 'skipped', 'ok']);
});

test('turn off records the first durable choice and leaves the task in its existing list', async t => {
  const entry = record('off', every(15), { lastRunAt: at(initial - min) });
  const f = await profile(t, [entry]);
  await f.scheduler.tickNow();
  const card = questions(f)[0];
  const edit = f.bot.api.editMessageText;
  t.mock.method(f.bot.api, 'editMessageText', async (...args) => {
    if (args[1] === card.messageId && args[2].includes('Решено:')) throw Error('fixture edit failure');
    return edit(...args);
  });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const decisionTarget = await fs.realpath(f.decisionFile);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === decisionTarget) {
      entered.resolve();
      await release.promise;
    }
    return rename(from, to);
  });
  const off = choose(f, card, 2);
  try {
    await Promise.race([entered.promise, off.then(() => assert.fail('Expected the first decision write'))]);
    const hourly = choose(f, card, 0);
    release.resolve();
    await Promise.all([off, hourly]);
  } finally {
    release.resolve();
  }
  assert.deepEqual(f.callbackAnswers.slice(-2).map(answer => answer[0]?.text).sort(),
    ['Решено: Выключить задачу', 'Уже решено: Выключить задачу']);
  assert.equal((await f.decisionBook()).decisions[subject(entry.id)].value, 'turn_off');
  assert.equal((await f.rows())[0].enabled, true);
  await f.advance(initial + 60 * min);
  assert.deepEqual(await f.rows(), [{ ...entry, enabled: false, disabledReason: 'owner' }]);
  assert.equal(f.deliveries().length, 0);
  assert.match(f.messages.at(-1), /выключил\. Из списка задача не пропала/);
  await f.callback('auto:tasks');
  assert.match(f.edits.at(-1), /Сохранено off/);
  assert.deepEqual((await f.runs()).map(row => row.status), ['skipped', 'skipped']);
});

test('a failed Telegram send retries the held card without stamping a run or duplicating the hold', async t => {
  const entry = record('retry-send', every(10));
  const f = await profile(t, [entry]);
  let attempts = 0;
  const send = f.bot.api.sendMessage;
  t.mock.method(f.bot.api, 'sendMessage', async (...args) => {
    if (args[1].startsWith(question) && ++attempts === 1) throw Error('fixture send failure');
    return send(...args);
  });
  await f.scheduler.tickNow();
  assert.deepEqual(await f.rows(), [{ ...entry, disabledReason: 'frequency' }]);
  assert.equal(questions(f).length, 0);
  await f.advance(initial + min);
  await f.advance(initial + 2 * min);
  assert.equal(attempts, 2);
  assert.equal(questions(f).length, 1);
  assert.deepEqual((await f.runs()).map(row => row.status), ['skipped']);
});

test('a saved hourly decision retries a failed file transition and reports its failure only once', async t => {
  const entry = record('retry-apply', every(10), { disabledReason: 'frequency' });
  const f = await profile(t, [entry]);
  await f.decisions({ [subject(entry.id)]: { value: 'hourly' } });
  let fail = true;
  const actionTarget = await fs.realpath(f.file);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (fail && to === actionTarget) throw Object.assign(Error('fixture write failure'), { code: 'EACCES' });
    return rename(from, to);
  });
  await f.scheduler.tickNow();
  await f.advance(initial + min);
  assert.deepEqual(await f.rows(), [entry]);
  assert.equal(f.messages.filter(text => text.includes('Твой выбор')).length, 1);
  assert.equal(f.deliveries().length, 0);
  assert.deepEqual((await f.runs()).map(row => row.status), ['blocked', 'blocked']);
  fail = false;
  await f.advance(initial + 2 * min);
  assert.deepEqual((await f.rows())[0].trigger, cron('0 * * * *'));
  assert.equal(questions(f).length, 0);
  assert.deepEqual((await f.runs()).map(row => row.status), ['blocked', 'blocked', 'skipped']);
});

test('if a posted question cannot be saved, it has no live buttons and the next offer can be answered', async t => {
  const entry = record('retry-pending', every(10));
  const f = await profile(t, [entry]);
  const decisionTarget = path.join(await fs.realpath(path.dirname(f.decisionFile)), path.basename(f.decisionFile));
  let fail = true;
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (fail && to === decisionTarget) throw Object.assign(Error('fixture pending write failure'), { code: 'EACCES' });
    return rename(from, to);
  });
  await f.scheduler.tickNow();
  const first = questions(f)[0];
  assert.deepEqual(f.markupEdits, [{ chatId: owner, messageId: first.messageId, options: { reply_markup: { inline_keyboard: [] } } }]);
  await assert.rejects(fs.stat(f.decisionFile), { code: 'ENOENT' });
  assert.equal((await f.rows())[0].disabledReason, 'frequency');
  fail = false;
  await f.advance(initial + min);
  const second = questions(f)[1];
  await choose(f, first, 0);
  assert.equal(lastAck(f), 'Карточка устарела');
  await choose(f, second, 2);
  assert.equal(lastAck(f), 'Решено: Выключить задачу');
  assert.equal((await f.decisionBook()).decisions[subject(entry.id)].value, 'turn_off');
});

test('only prompts supported by the selected route get a local frequency decision', async t => {
  const own = record('claude', every(15), { lastRunAt: at(initial),
    task: { kind: 'prompt', prompt: 'fixture Claude action', provider: 'claude' } });
  const unsupported = [
    record('codex', every(15), { task: { kind: 'prompt', prompt: 'fixture Codex action', provider: 'codex' } }),
    record('shell', every(15), { task: { kind: 'prompt', prompt: 'fixture shell action', shell: true } }),
  ];
  const f = await profile(t, [own, ...unsupported], {
    state: { extAuthBypass: 'claude', authMode: 'subscription', hasSubscriptionAuth: true },
  });
  await f.decisions({ [subject('codex')]: { value: 'hourly' }, [subject('shell')]: { value: 'turn_off' } });
  await f.scheduler.tickNow();
  assert.deepEqual(await f.rows(), [{ ...own, disabledReason: 'frequency' }, ...unsupported]);
  assert.equal(questions(f).length, 1);
  assert.match(questions(f)[0].text, /Сохранено claude/);
  assert.deepEqual((await f.runs()).map(row => [row.actionId, row.status]), [['claude', 'skipped']]);
});
