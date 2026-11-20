/**
 * Old per-profile owner-decisions.json. [Telegram](../telegram/frequency-confirmation.mjs)
 * publishes and settles the short ID. [Scheduler brake](./reminder-frequency-brake.mjs)
 * applies the saved choice. Preserve neighboring decision types in the same file.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { withFileLock } from '../../shared/file-lock.mjs';
import { actionRoot } from '../paths.mjs';
import { physicalRecordPath, readOptionalJson, writeRecordJson } from './record-file.mjs';
import { reminderFrequencyChoices } from './reminder-frequency.mjs';

const decisionsPath = env => path.join(actionRoot(env), 'owner-decisions.json');
const isMap = value => value && typeof value === 'object' && !Array.isArray(value);
const isFrequency = row => typeof row?.subject === 'string' &&
  row.subject.startsWith('autonomy-cron:') && row.subject.endsWith(':frequency');

async function readBook(file) {
  const saved = await readOptionalJson(file);
  if (saved === undefined) return { decisions: {}, pending: {} };
  if (!isMap(saved) || ['decisions', 'pending'].some(key => Object.hasOwn(saved, key) && !isMap(saved[key]))) {
    throw new Error('Expected an owner decision book');
  }
  return { decisions: {}, pending: {}, ...saved };
}

export async function readReminderFrequencyDecisions(env = process.env) {
  const saved = await readOptionalJson(decisionsPath(env)).catch(() => undefined);
  return isMap(saved?.decisions) ? saved.decisions : {};
}

async function withDecisionBook(env, update) {
  const logical = decisionsPath(env);
  const file = await physicalRecordPath(logical);
  return withFileLock(file, async () => {
    const save = async book => {
      if (await physicalRecordPath(logical) !== file) throw new Error('Owner decision file changed');
      await writeRecordJson(file, book, { create: true });
    };
    if (await physicalRecordPath(logical) !== file) throw new Error('Owner decision file changed');
    return update(await readBook(file), save);
  });
}

export function proposeFrequencyDecision(question, { chatId, now, post, env = process.env }) {
  return withDecisionBook(env, async (book, save) => {
    if (book.decisions[question.subject] || Object.values(book.pending).some(row => row?.subject === question.subject)) return;
    const used = new Set(Object.values(book.decisions).map(row => row?.cardShortId));
    let shortId;
    do { shortId = randomBytes(4).toString('hex'); }
    while (Object.hasOwn(book.pending, shortId) || used.has(shortId));

    // Only the per-profile decision lock spans the bounded send. An immediate
    // tap or a concurrent scheduler waits for the message binding to commit.
    const msgId = await post({ ...question, shortId });
    if (!Number.isSafeInteger(msgId) || msgId <= 0) return;
    book.pending[shortId] = { ...question, shortId, msgId, chatId, sentAt: new Date(now()).toISOString() };
    await save(book);
  });
}

function choiceFor(card, token) {
  if (!Array.isArray(card.options)) return;
  const index = /^#([0-3])$/.exec(token)?.[1];
  const value = index === undefined ? token : card.options[Number(index)]?.value;
  if (!card.options.some(option => option?.value === value)) return;
  return reminderFrequencyChoices.find(choice => choice.value === value);
}

export async function settleFrequencyDecision(data, { chatId, msgId, ownerChat, now, env = process.env }) {
  const [, shortId, token] = /^dc:([0-9a-f]{6,12}):(.+)$/.exec(data) || [];
  if (!shortId) return;
  return withDecisionBook(env, async (book, save) => {
    const card = book.pending[shortId];
    if (!card) {
      const decided = Object.values(book.decisions).find(row => isFrequency(row) && row.cardShortId === shortId);
      if (decided && typeof decided.label === 'string') return { label: decided.label };
      return;
    }
    if (!isFrequency(card) || card.msgId !== msgId || (card.chatId ?? ownerChat) !== chatId) return;
    const choice = choiceFor(card, token);
    if (!choice) return;
    const previous = book.decisions[card.subject];
    // An older retry may have left two pending messages for one subject.
    if (previous) return typeof previous.label === 'string' ? { label: previous.label } : undefined;
    book.decisions[card.subject] = { subject: card.subject, ...choice, decidedAt: new Date(now()).toISOString(),
      producedBy: card.producedBy, cardShortId: shortId };
    delete book.pending[shortId];
    await save(book);
    return { card, label: choice.label };
  });
}
