/**
 * Old conversational timer markers over [schedules](../autonomy/legacy-timer-actions.mjs).
 * [Worker](./bot.mjs) recognizes original commands before sibling output and
 * applies them after saved task control. [Delete card](./legacy-timer-confirmation.mjs).
 * [Ingress checks](../../tests/legacy-timer-conversation.test.mjs).
 */
import { listTimersFromTurn, planTimerDeletion, setTimerFromTurn } from '../autonomy/legacy-timer-actions.mjs';
import { legacyTimerMarker, literalAutonomyRanges, maskAutonomyRanges, outsideRanges, replaceAutonomyMarkers, reserveAutonomyMarkers,
  restoreAutonomyLiterals, taskCancelMarker, taskMutationRanges, taskRescheduleMarker } from './autonomy-marker-text.mjs';
import { askToDeleteLegacyTimer } from './legacy-timer-confirmation.mjs';
import { describeLegacyTimerClock, describeLegacyTimerList, describeLegacyTimerPhrase } from './screens/legacy-timers.mjs';

const prefix = '[MSB_LEGACY_TIMER:';
const tokenPattern = /\[MSB_LEGACY_TIMER:[a-f0-9-]+-\d+\]/g;
const operations = ['LIST_TIMERS', 'TIMER_OFF', 'TIMER_ON', 'TIMER_DELETE'];
const claim = /^\s*(?:[✅✔]\uFE0F?\s*)?(?:(?:я|уже)\s+){0,2}(?:готово|(?:выключил|включил|удалил)[аи]?)(?=$|[\s.,!])/iu;
const failures = {
  LIST_TIMERS: 'Не удалось показать таймеры.',
  TIMER_OFF: 'Не удалось выключить таймер.',
  TIMER_ON: 'Не удалось включить таймер.',
  TIMER_DELETE: 'Не удалось спросить про удаление.',
};
const noQuestion = 'Удаление только после подтверждения кнопкой, а спросить сейчас не получилось. Удалить можно в настройках, раздел Таймеры.';

export function prepareLegacyTimerMarkers(text) {
  if (typeof text !== 'string' || !/\[(?:LIST_TIMERS\]|TIMER_(?:OFF|ON|DELETE):)/.test(text)) return { text };
  const { payloads } = taskMutationRanges(text, [...text.matchAll(taskCancelMarker), ...text.matchAll(taskRescheduleMarker)]);
  const blocks = outsideRanges(text, legacyTimerMarker, payloads);
  const literals = literalAutonomyRanges(maskAutonomyRanges(text, blocks));
  const reserved = blocks.map(block => ({
    ...block, operation: block[1] ?? block[2],
    literal: literals.some(range => range.index <= block.index && block.index < range.index + range[0].length),
  }));
  return reserveAutonomyMarkers(text, reserved, prefix);
}

function describeSelection(result) {
  if (!result.matches) return result;
  return { error: 'Нашёл несколько таймеров, уточни:\n' +
    result.matches.map(timer => '• «' + timer.name + '»: ' + describeLegacyTimerPhrase(timer)).join('\n') };
}

function describeToggle({ timer, wasEnabled }, enabled) {
  const name = '«' + timer.name + '»';
  if (!enabled) {
    const text = wasEnabled ? 'Готово: таймер ' + name + ' выключил.' : 'Таймер ' + name + ' уже выключен.';
    return { text: text + ' Включу словом.' };
  }
  const clock = describeLegacyTimerClock(timer);
  return { text: wasEnabled ? 'Таймер ' + name + ' и так работает: ' + clock + '.'
    : 'Готово: таймер ' + name + ' снова работает — ' + clock + '.' };
}

async function applyTimerMarker(block, context, ctx) {
  context.signal?.throwIfAborted();
  if (!context.ownerId || !context.ok) return { text: '(задача не обработана)' };
  const { operation } = block;
  try {
    if (operation === 'LIST_TIMERS') {
      const result = await listTimersFromTurn(context);
      return result.error ? result : { text: describeLegacyTimerList(result.timers) };
    }
    const selector = block[3];
    if (selector === undefined) return { error: 'Уточни, какой таймер.' };
    if (operation === 'TIMER_DELETE') {
      const result = await planTimerDeletion(selector, context);
      if (!result.timer) return describeSelection(result);
      if (!await askToDeleteLegacyTimer(ctx, result, context)) return { error: noQuestion };
      return { text: 'Спросил подтверждение ниже, удалю по кнопке.', awaitingConfirmation: true };
    }
    const enabled = operation === 'TIMER_ON';
    const result = await setTimerFromTurn(selector, enabled, context);
    return result.timer ? describeToggle(result, enabled) : describeSelection(result);
  } catch {
    context.signal?.throwIfAborted();
    return { error: failures[operation] };
  }
}

export async function processLegacyTimerMarkers(text, context, ctx, { commands }) {
  if (!commands) return text;
  const active = [...text.matchAll(tokenPattern)].filter(block => commands.has(block[0]) && !commands.get(block[0]).literal);
  const results = new Map();
  for (const operation of operations) {
    for (const block of active.filter(item => commands.get(item[0]).operation === operation)) {
      results.set(block, await applyTimerMarker(commands.get(block[0]), context, ctx));
    }
  }
  return replaceAutonomyMarkers(text, active, block => results.get(block), {
    claim, correctBeforeEach: true, quoteGuard: /\x60/u,
  });
}

export function restoreLegacyTimerLiterals(text, { commands }) {
  return restoreAutonomyLiterals(text, commands, tokenPattern);
}
