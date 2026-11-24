/**
 * Owner-only notification preferences and examples.
 * [Callback ACK and rendering](../router.mjs), [preferences](../../notification-mutes.mjs),
 * [demo messages](../../notifications/demo.mjs), [handler tests](../../../tests/notification-settings.test.mjs).
 */
import { NOTICE_KINDS, readNoticeMutes, setNoticeMuted } from '../../notification-mutes.mjs';
import { DEMO_TOO_SOON, sendNoticeDemos } from '../../notifications/demo.mjs';
import { notificationsScreen } from '../screens/settings.mjs';
import { resumeFromPauseNotice } from '../pause-markers.mjs';
import { UNHANDLED } from './shared.mjs';
import { trackCallbackTask } from '../../../shared/callback-renders.mjs';

const demoTaps = new WeakMap();
const resuming = new WeakSet();

export function isNoticeCallback(data) {
  return data === 'pause-off' || /^nm:.+$/.test(data);
}

export async function handleNoticeRoute({ data, answer, show, bot, ctx, chatId, msgId, now, cfg, state }) {
  if (!isNoticeCallback(data)) return UNHANDLED;
  const message = ctx.callbackQuery.message;
  const threadId = message?.message_thread_id;
  const topic = threadId ? { message_thread_id: threadId } : {};
  const renderSettings = (preferences, note) => show({
    ...notificationsScreen(preferences, note), replyThreadId: threadId,
  });
  const showSettings = async note => renderSettings(await readNoticeMutes(), note);
  const removeTappedButton = () => {
    if (!msgId) return;
    const inline_keyboard = (message.reply_markup?.inline_keyboard ?? [])
      .map(row => row.filter(button => button.callback_data !== data))
      .filter(row => row.length > 0);
    return bot.api.editMessageReplyMarkup(chatId, msgId, { reply_markup: { inline_keyboard } }).catch(() => {});
  };

  try {
    if (data === 'pause-off') {
      if (resuming.has(bot)) return answer({ text: 'Уже снимаю, подожди' });
      resuming.add(bot);
      await answer({ text: 'Снимаю паузу…' });
      const task = (async () => {
        const result = await resumeFromPauseNotice({
          ownerId: cfg.adminId, now: now(), timezone: state.timezone || cfg.timezone,
          codexAvailable: Boolean(bot[Symbol.for('msb.savedCodexPrompt')]),
          cursorAvailable: Boolean(bot[Symbol.for('msb.savedCursorPrompt')]),
        }, ctx);
        if (!result.error) await removeTappedButton();
        await bot.api.sendMessage(chatId, result.error || result.text, topic).catch(() => {});
      })().catch(() => bot.api.sendMessage(chatId,
        'Не смог снять паузу, нажми ещё раз или напиши «сними паузу».', topic).catch(() => {}))
        .finally(() => resuming.delete(bot));
      trackCallbackTask(bot, task);
      return;
    }
    if (data === 'nm:list') {
      await answer();
      return await showSettings();
    }
    if (data === 'nm:demo') {
      const at = now();
      const previous = demoTaps.get(bot);
      if (previous && at - previous.at < 10_000) {
        // A repeat tap on the same menu invalidates its original callback render.
        // Retain the latest renderer so the already-running batch can report its result.
        if (previous.pending && previous.chatId === chatId && previous.msgId === msgId) previous.render = renderSettings;
        return answer({ text: DEMO_TOO_SOON });
      }
      const tap = { at, chatId, msgId, pending: true, render: renderSettings };
      demoTaps.set(bot, tap);
      await answer({ text: 'Присылаю примеры…' });
      const task = (async () => {
        try {
          const note = await sendNoticeDemos({
            now: at, timezone: state.timezone || cfg.timezone,
            send: (text, keyboard) => bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard, ...topic }),
          });
          const preferences = await readNoticeMutes();
          await tap.render(preferences, note);
        } catch (error) {
          console.error('[msb/notice-demo]', error.code || error.name);
          await bot.api.sendMessage(chatId, 'Не смог прислать примеры, нажми «🧪» ещё раз через 10 секунд.', topic).catch(() => {});
        } finally {
          tap.pending = false;
          tap.render = undefined;
        }
      })();
      trackCallbackTask(bot, task);
      return;
    }
    const unmute = data.startsWith('nm:on:');
    const kind = data.slice(unmute ? 'nm:on:'.length : 'nm:'.length);
    if (!Object.hasOwn(NOTICE_KINDS, kind)) return answer({ text: 'Не разобрал кнопку' });
    const { name } = NOTICE_KINDS[kind];
    const changed = await setNoticeMuted(kind, !unmute, now());
    if (unmute) {
      await answer({ text: changed ? 'Вернул' : 'Уже включено' });
      const line = changed ? `Вернул: ${name} снова будет приходить.` : `${name.charAt(0).toUpperCase()}${name.slice(1)} и так приходит.`;
      return await showSettings(line);
    }
    await answer({ text: changed ? 'Запомнил' : 'Уже отключено' });
    await removeTappedButton();
    if (changed) {
      const reply = `Хорошо, запомнил: больше не пришлю ${name}. Вернуть: /settings → 🔕 Отключённые уведомления.`;
      await bot.api.sendMessage(chatId, reply, topic).catch(() => {});
    }
  } catch (error) {
    console.error('[msb/notice-mute]', error.code || error.name);
    await answer({ text: 'Не получилось, попробуй ещё раз', show_alert: true });
  }
}
