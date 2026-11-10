/**
 * Мониторинг: источники, дайджест и настройки.
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { listSourcesFlat, loadMonitorConfig } from '../../monitor/config.mjs';
import { sourceCallbackData } from '../../monitor/source-ref.mjs';
import { loadMeta } from '../../monitor/store.mjs';
import { loadState } from '../../state.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

export async function monitorScreen(back = 'menu:back') {
  const cfg = await loadMonitorConfig();
  const meta = await loadMeta();
  const sources = listSourcesFlat(cfg);
  const broken = sources.filter((s) => {
    const bucket = cfg[s.type];
    const list =
      s.type === 'youtube'
        ? bucket.channels
        : s.type === 'twitter'
          ? bucket.accounts
          : s.type === 'github'
            ? bucket.repos
            : s.type === 'telegram'
              ? bucket.channels
              : bucket.feeds;
    const row = (list || []).find((x) => (x.url || x.username || x.channelId || x.handle || `${x.owner}/${x.repo}`) === s.id || x.name === s.name);
    return Boolean(row?.lastError);
  });
  const lines = ['<b>📡 Мониторинг</b>', ''];
  if (!sources.length) {
    lines.push('Статус: нет источников.');
    lines.push('');
    lines.push('Добавь YouTube, X, GitHub, Telegram или RSS — бот будет собирать и присылать дайджест.');
  } else if (broken.length) {
    lines.push(`Статус: ⚠️ ${broken.length} источник(а) с ошибками`);
    lines.push('Открой источники — там детали.');
  } else {
    lines.push(`Статус: ✔ ${sources.length} источник(ов)`);
    const last = Object.values(meta.lastPollAt || {}).sort().slice(-1)[0];
    if (last) lines.push(`Последний сбор: ${last.slice(0, 19).replace('T', ' ')}`);
    lines.push(
      `Дайджест: ${cfg.digest?.enabled ? `каждый день в ${cfg.digest.hour}:00` : 'выключен'} · top ${cfg.digest?.topN || 10}`,
    );
  }
  lines.push(BLANK);
  return {
    text: lines.join('\n'),
    keyboard: new InlineKeyboard()
      .text('🛰️ Источники', 'mon:sources')
      .text('📨 Дайджест', 'mon:digest')
      .row()
      .text('⚙️ Настройки', 'mon:settings')
      .text('❔ Что это', 'mon:help')
      .row()
      .text('« Назад', back),
  };
}

export async function monitorSourcesScreen() {
  const cfg = await loadMonitorConfig();
  const sources = listSourcesFlat(cfg);
  const kb = new InlineKeyboard();
  let text;
  if (!sources.length) {
    text = `<b>🛰️ Источники</b>\n\nПока пусто.\n\n+ Добавить источник — пришли ссылку или @ник.\n${BLANK}`;
  } else {
    const lines = sources.map((s) => `• <b>${escapeHtml(s.type)}</b> ${escapeHtml(s.name)}`);
    text = `<b>🛰️ Источники</b> (${sources.length})\n\n${lines.join('\n')}\n${BLANK}`;
    for (const s of sources.slice(0, 20)) {
      kb.text(`🗑 ${s.type}:${s.name}`.slice(0, 40), sourceCallbackData(s.type, s.id)).row();
    }
  }
  kb.text('+ Добавить источник', 'mon:add-hint').row();
  kb.text('« Назад', 'mon:back');
  return { text, keyboard: kb };
}

export async function monitorDigestScreen() {
  const cfg = await loadMonitorConfig();
  const { state } = await loadState();
  const on = cfg.digest?.enabled !== false;
  return {
    text: `<b>📨 Дайджест</b>

Сейчас: <b>${on ? 'включён' : 'выключен'}</b>
Время: <b>${cfg.digest?.hour ?? 9}:00</b> (${escapeHtml(state.timezone || process.env.MSB_TIMEZONE || 'Europe/Moscow')})
Материалов: <b>${cfg.digest?.topN ?? 10}</b>
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text(on ? '⏸ Выключить' : '▶️ Включить', 'mon:digest-toggle')
      .row()
      .text('🕘 8:00', 'mon:digest:time:set:8')
      .text('🕘 9:00', 'mon:digest:time:set:9')
      .text('🕘 18:00', 'mon:digest:time:set:18')
      .row()
      .text('🔢 10', 'mon:digest:count:set:10')
      .text('🔢 15', 'mon:digest:count:set:15')
      .text('🔢 25', 'mon:digest:count:set:25')
      .row()
      .text('📨 Прислать сейчас', 'digest:now')
      .row()
      .text('« Назад', 'mon:back'),
  };
}

export function monitorHelpScreen() {
  return {
    text: `<b>❔ Что такое мониторинг</b>

Следит за названными источниками и собирает дайджест. Источники добавляются ссылкой или @ником.
${BLANK}`,
    keyboard: new InlineKeyboard().text('« Назад', 'mon:back'),
  };
}

export function monitorSettingsScreen() {
  return {
    text: `<b>⚙️ Настройки мониторинга</b>

Выбор хранилища сохраняется. Текущий open-core записывает материалы в JSONL; backend SQLite пока не подключён.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('💾 jsonl', 'mon:storage:set:jsonl')
      .text('💾 sqlite', 'mon:storage:set:sqlite')
      .row()
      .text('⚡ Собрать всё сейчас', 'mon:poll:all')
      .row()
      .text('« Назад', 'mon:back'),
  };
}
