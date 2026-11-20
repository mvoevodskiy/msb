/**
 * Список, добавление и удаление ботов.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { botDetailScreen, botsScreen } from '../screens.mjs';
import { removeBot } from '../../bots/manage.mjs';
import { UNHANDLED } from './shared.mjs';

export async function handleBotsRoute({ data, show, pending, chatId, bot }) {
  if (data === 'settings:bots' || data === 'settings:bots:refresh') return show(await botsScreen());
  if (data === 'settings:bots:add') {
    pending.set(chatId, 'bot-token');
    return show({
      text: `👾 <b>Новый бот</b>\n\nПришли токен от @BotFather (<code>1234567890:ABC…</code>).\nЯ сам поставлю юнит через <code>sudo bot-ctl.sh add</code>.`,
      keyboard: (await botsScreen()).keyboard,
    });
  }
  if (data === 'settings:bots:cancel') {
    pending.delete(chatId);
    return show(await botsScreen());
  }
  if (data.startsWith('settings:bots:bot:')) {
    return show(await botDetailScreen(data.slice('settings:bots:bot:'.length)));
  }
  if (data.startsWith('settings:bots:delete-confirm:')) {
    const id = data.slice('settings:bots:delete-confirm:'.length);
    const res = await removeBot(id);
    await bot.api.sendMessage(chatId, res.ok ? `✔ Удалён <b>${id}</b>` : `Не удалось: ${res.error}`, {
      parse_mode: 'HTML',
    });
    return show(await botsScreen());
  }
  if (data.startsWith('settings:bots:delete:')) {
    const id = data.slice('settings:bots:delete:'.length);
    return show({
      text: `🗑 <b>Удалить ${id}?</b>\n\nПереписки и настройки сотрутся. Бот в Telegram останется.`,
      keyboard: new InlineKeyboard()
        .text(`Да, удалить ${id}`, `settings:bots:delete-confirm:${id}`)
        .row()
        .text('✖ Отмена', `settings:bots:bot:${id}`),
    });
  }
  return UNHANDLED;
}
