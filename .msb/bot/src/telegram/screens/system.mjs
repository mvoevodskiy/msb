import profile from '../../../shared/profile.cjs';
/**
 * Системные экраны: обновления, перезапуск, SSH, STT и Пульт.
 * Pult data readiness/root → [adapter](../../pult/status.mjs),
 * manual refresh → [route](../routes/system.mjs), [checks](../../../tests/pult-status.test.mjs).
 * Навигация: [Telegram](../README.md).
 */
import { InlineKeyboard } from 'grammy';
import { parsePultStatus } from '../../pult/status.mjs';
import { checkOwnUpdates } from '../../updates/client.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

export function extrasScreen() {
  return {
    text: `<b>🔧 Системные</b>

🌐 <b>SSH доступ к серверу</b> — ключи, файрвол, прямое подключение.
♻️ <b>Перезапустить бота</b> — нужен после обновления кода.
🎤 <b>Расшифровка голоса</b> — Deepgram / STT_COMMAND.
🖥 <b>Пульт</b> — веб-панель ботов, задач и сервера (выкл по умолчанию).
📦 <b>Обновления</b> — свой канал (не vendor создателя).
💾 <b>Хранилище мониторинга</b> — в Мониторинг → ⚙️ Настройки.`,
    keyboard: new InlineKeyboard()
      .text('🌐 SSH доступ к серверу', 'settings:ssh')
      .row()
      .text('♻️ Перезапустить бота', 'settings:restart')
      .row()
      .text('🎤 Расшифровка голоса: Deepgram', 'settings:stt')
      .row()
      .text('🖥 Пульт', 'settings:pult')
      .row()
      .text('📦 Обновления', 'settings:updates')
      .row()
      .text('« Назад', 'settings:back'),
  };
}

/**
 * Раздел настроек Пульта: пароль, вкл/выкл, IP прослушивания, опц. бот тревог.
 * @param {object|null} pultSnap — блок pult из msb-engine
 * @param {object} cfg — { password, host, tgToken, publicUrl, sessionHours }
 * @param {string} note
 */
export function pultScreen(pultSnap = null, cfg = {}, note = '') {
  const p = parsePultStatus(pultSnap);
  const installed = p.installed;
  const on = p.enabled;
  const active = p.active;
  let status;
  if (!p.known) status = 'нет данных от помощника — нажми «Обновить»';
  else if (!installed) status = `полная установка Пульта не найдена (${p.root}) — проверь ядро и службы`;
  else if (on && active) status = 'включён, службы работают';
  else if (on) status = 'включён, но службы не active — journalctl -u pult-web';
  else status = 'выключен';

  const password = cfg.password ? 'задан' : 'не задан';
  const host = cfg.host || '127.0.0.1';
  const hostLabel =
    host === '0.0.0.0' || host === '::'
      ? 'все интерфейсы (0.0.0.0)'
      : host === '127.0.0.1' || host === '::1'
        ? 'только localhost'
        : host;
  const tg = cfg.tgToken ? 'задан' : 'нет (необязателен)';
  const url = cfg.publicUrl || process.env.PULT_PUBLIC_URL || 'http://127.0.0.1:8791';
  const sessionHours = Number(cfg.sessionHours) > 0 ? Number(cfg.sessionHours) : 4;

  const kb = new InlineKeyboard();
  if (installed) {
    if (on) kb.text('⏸ Выключить', 'settings:pult:off').row();
    else kb.text('▶️ Включить', 'settings:pult:on').row();
  }
  kb.text('🔑 Пароль', 'settings:pult:password').row();
  kb.text('🌐 Адрес прослушивания', 'settings:pult:listen').row();
  kb.text(`⏱ Сессия: ${sessionHours} ч`, 'settings:pult:session').row();
  kb.text('🤖 Бот тревог (опц.)', 'settings:pult:tg-token').row();
  kb.text('🔗 Публичный URL', 'settings:pult:url').row();
  kb.text('🔄 Обновить', 'settings:pult:refresh').row();
  kb.text('« Назад', 'settings:extras');

  return {
    text: `<b>🖥 Пульт</b>

Веб-панель ботов, задач и сервера. Открывается командой <code>/pult</code> из любого бота.
Mini App — вход по подписи Telegram; веб-ссылка — одноразовая (билет сгорает при любом переходе).

Статус: <b>${escapeHtml(status)}</b>
Пароль: <b>${escapeHtml(password)}</b>
Слушает: <b>${escapeHtml(hostLabel)}</b> (<code>${escapeHtml(host)}</code>)
Сессия браузера: <b>${sessionHours} ч</b>
Бот тревог/сводки: <b>${escapeHtml(tg)}</b>
Публичный URL: <code>${escapeHtml(url)}</code>
${note ? `\n${note}` : ''}
${BLANK}`,
    keyboard: kb,
  };
}

export function pultListenScreen(currentHost = '127.0.0.1') {
  return {
    text: `<b>🌐 Адрес прослушивания Пульта</b>

Сейчас: <code>${escapeHtml(currentHost)}</code>

• <b>localhost</b> — только с этой машины
• <b>все интерфейсы</b> — LAN / nginx на том же хосте
• <b>свой IP</b> — конкретный адрес сетевого интерфейса
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('🔒 localhost', 'settings:pult:listen:set:127.0.0.1')
      .row()
      .text('🌐 Все (0.0.0.0)', 'settings:pult:listen:set:0.0.0.0')
      .row()
      .text('✏️ Свой IP', 'settings:pult:listen:custom')
      .row()
      .text('« Назад', 'settings:pult'),
  };
}

export async function updatesScreen() {
  const st = await checkOwnUpdates();
  return {
    text: `<b>📦 Обновления</b>

Vendor-канал создателя закрытого ядра <b>отключён</b>.

Свой сервис: <code>${profile.profileEnvKey('MSB_OWN_UPDATES_URL')}</code>
Статус: ${escapeHtml(st.message)}
Установка обновлений через меню пока не реализована.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('🔄 Проверить', 'settings:updates')
      .row()
      .text('« Назад', 'settings:extras'),
  };
}

export function restartConfirmScreen() {
  return {
    text: 'Перезапустить процесс бота? Активный ход будет прерван.',
    keyboard: new InlineKeyboard()
      .text('✅ Перезапустить', 'settings:restart:do')
      .text('Отмена', 'settings:extras'),
  };
}

export function sshUnavailableScreen() {
  return {
    text: `<b>🔐 SSH доступ к серверу</b>

⚠️ Не удалось получить статус (constructor API недоступен в open-core без хаба).

На боксе с обвязкой открой тот же экран через overlay — локальный SSH IP там уже есть.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('🔄 Обновить', 'settings:ssh')
      .row()
      .text('« Назад', 'settings:extras'),
  };
}

export function sttScreen() {
  return {
    text: `<b>🎤 Расшифровка голоса</b>

Провайдер: Deepgram / <code>STT_COMMAND</code>. Ключ — в «Переменные окружения».
${BLANK}`,
    keyboard: new InlineKeyboard().text('« Назад', 'settings:extras'),
  };
}
