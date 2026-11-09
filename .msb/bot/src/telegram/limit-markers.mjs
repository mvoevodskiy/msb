/**
 * Final [owner turn](./bot.mjs) → [limit protocol](../autonomy/limit-protocol.mjs)
 * → [writer](../autonomy/limit-control.mjs) or [zero question](./limit-confirmation.mjs).
 * [Production ingress checks](../../tests/autonomy-limit-control.test.mjs).
 */
import { LimitRouteRefusal, requireLocalLimitRoute, setAutonomyLimit } from '../autonomy/limit-control.mjs';
import { limitDefinition, parseLimitMarker } from '../autonomy/limit-protocol.mjs';
import { limitMarker, outsideExamples, replaceAutonomyMarkers, scheduleMarker, taskControlMarker, taskInspectionMarker } from './autonomy-marker-text.mjs';
import { askToRemoveLimit } from './limit-confirmation.mjs';

const couldNotAsk = 'Снятие предела подтверждается кнопкой, а спросить сейчас не получилось. Назови ненулевое значение или попробуй ещё раз.';

const limitClaim = /(?:^|\s)готово(?=$|[\s.,!])|(?:снял[аи]?|убрал[аи]?|изменил[аи]?|поменял[аи]?)\s+(?:дневной\s+)?(?:предел|лимит|запас|резерв)|(?:предел|лимит|запас|резерв)\s+(?:снят|убран|измен[её]н)/iu;

async function applyLimit(payload, context, ctx) {
  const { rail, signal } = context;
  const parsed = parseLimitMarker(payload);
  if (parsed.error) return parsed;
  const { key, value } = parsed;
  try {
    await requireLocalLimitRoute(rail);
    if (value === 0) {
      if (!await askToRemoveLimit(ctx, key, context)) {
        return { error: couldNotAsk };
      }
      return { text: 'Спросил подтверждение ниже — сниму предел по кнопке.', awaitingConfirmation: true };
    }
    await setAutonomyLimit(key, value, context);
    return { text: limitDefinition(key).success(value) };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LimitRouteRefusal) return { error: error.message };
    return { error: value === 0 ? couldNotAsk : 'Не удалось изменить предел автономки.' };
  }
}

export async function processLimitMarkers(text, context, ctx) {
  if (typeof text !== 'string' || !text.includes('[SET_LIMIT')) return text;
  const blocks = outsideExamples(text, limitMarker, [...text.matchAll(scheduleMarker), ...text.matchAll(taskControlMarker), ...text.matchAll(taskInspectionMarker)]);
  return replaceAutonomyMarkers(text, blocks, async block => {
    context.signal?.throwIfAborted();
    if (!context.ownerId || !context.ok) return { text: '(предел не изменён)' };
    return applyLimit(block[1], context, ctx);
  }, { claim: limitClaim, correctLeading: true });
}
