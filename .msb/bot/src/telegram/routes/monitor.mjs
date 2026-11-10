/**
 * Мониторинг: источники, дайджест, сбор и настройки.
 * Навигация: [Telegram](../README.md).
 */
import { monitorDigestScreen, monitorHelpScreen, monitorScreen, monitorSettingsScreen, monitorSourcesScreen, placeholder } from '../screens.mjs';
import { removeSource } from '../../monitor/config.mjs';
import { pollAllSources } from '../../monitor/poll.mjs';
import { buildDigestText, updateDigestSettings } from '../../monitor/digest.mjs';
import { UNHANDLED } from './shared.mjs';

export async function handleMonitorRoute({ data, show, pending, chatId, bot }) {
  // —— monitor ——
  if (data === 'mon:back' || data === 'auto:monitor') return show(await monitorScreen(data === 'auto:monitor' ? 'auto:home' : 'menu:back'));
  if (data === 'mon:sources') return show(await monitorSourcesScreen());
  if (data === 'mon:digest') return show(await monitorDigestScreen());
  if (data === 'mon:help') return show(monitorHelpScreen());
  if (data === 'mon:settings') return show(monitorSettingsScreen());
  if (data === 'mon:add-hint') {
    pending.set(chatId, 'mon-source');
    return show({
      text: 'Пришли ссылку или @ник источника (YouTube, X, GitHub, Telegram, RSS).',
      keyboard: (await monitorSourcesScreen()).keyboard,
    });
  }
  if (data.startsWith('mon:src-key:')) {
    const parts = data.split(':');
    const [, , type, token] = parts;
    if (parts.length === 4 && type && /^[a-f0-9]{32}$/.test(token || '')) {
      await removeSource(type, token, process.env, { byToken: true });
    }
    return show(await monitorSourcesScreen());
  }
  if (data.startsWith('mon:src-del:')) {
    const rest = data.slice('mon:src-del:'.length);
    const i = rest.indexOf(':');
    const type = rest.slice(0, i);
    const id = decodeURIComponent(rest.slice(i + 1));
    await removeSource(type, id);
    return show(await monitorSourcesScreen());
  }
  if (data === 'mon:digest-toggle') {
    await updateDigestSettings((digest) => ({ enabled: !(digest?.enabled !== false) }));
    return show(await monitorDigestScreen());
  }
  if (data.startsWith('mon:digest:time:set:')) {
    await updateDigestSettings({ hour: Number(data.split(':').pop()) });
    return show(await monitorDigestScreen());
  }
  if (data.startsWith('mon:digest:count:set:')) {
    await updateDigestSettings({ topN: Number(data.split(':').pop()) });
    return show(await monitorDigestScreen());
  }
  if (data === 'digest:now') {
    const dig = await buildDigestText();
    await bot.api.sendMessage(chatId, dig.text, { parse_mode: 'HTML' });
    return show(await monitorDigestScreen());
  }
  if (data === 'mon:poll:all') {
    await bot.api.sendMessage(chatId, '⏳ Собираю источники…');
    const res = await pollAllSources();
    await bot.api.sendMessage(
      chatId,
      `Готово: новых ${res.added}, ошибок ${res.errors.length}.`,
    );
    return show(await monitorScreen());
  }
  if (data.startsWith('mon:storage:set:')) {
    const { updateMonitorConfig } = await import('../../monitor/config.mjs');
    await updateMonitorConfig((cfg) => { cfg.storage = data.split(':').pop(); });
    return show(monitorSettingsScreen());
  }
  if (
    data.startsWith('mon:storage') ||
    data.startsWith('mon:model') ||
    data.startsWith('mon:notif') ||
    data.startsWith('mon:reportstyle') ||
    data.startsWith('mon:collection') ||
    data.startsWith('mon:balance') ||
    data === 'mon:scored' ||
    data === 'mon:feed' ||
    data === 'mon:search' ||
    data === 'mon:incident'
  ) {
    return show(placeholder('Мониторинг', 'mon:settings'));
  }

  return UNHANDLED;
}
