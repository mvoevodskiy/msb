/**
 * Owner-triggered old notice examples with the same mute controls as real sends.
 * Uses synthetic balance/provider values and reads only local pause/monitor state.
 * [Telegram callback](../telegram/routes/notifications.mjs),
 * [handler checks](../../tests/notification-settings.test.mjs).
 */
import { loadMonitorConfig } from '../monitor/config.mjs';
import { formatPauseNotice, PAUSE_OFF_BUTTON, readPauseNoticeSnapshot } from '../autonomy/pause-notice-text.mjs';
import { NOTICE_KINDS, isNoticeMuted, noticeMuteKeyboard } from '../notification-mutes.mjs';

export const DEMO_TOO_SOON = 'Примеры только что ушли, подожди 10 секунд';

const DAY = 86_400_000;

function balanceDemo() {
  return {
    text: [
      'Цифры в примере выдуманные.',
      '⚠ Остаток аккаунта на обычном ключе OpenRouter не виден: OpenRouter отдаёт его только управляющему ключу. Если строка про остаток сама не приходит, это не поломка.',
      '',
      '📡 <b>Мониторинг — баланс</b>',
      '',
      'OpenRouter: осталось $3.20 (порог $5)',
      'Расход мониторинга сегодня $8.40 из $10 — 84%',
      '',
      'Пополни, чтобы сбор не остановился.',
    ],
  };
}

function creditsDemo() {
  return {
    text: [
      'Приходит, когда у провайдера модели кончились деньги, один раз на поломку.',
      '',
      '💳 Кредиты провайдера закончились.',
      'Пополни баланс на openrouter.ai, заработает сразу.',
      'Или переключись на другой движок: /settings → 🔌 Подключение',
      '💬 Сессии: прошлая беседа сохранена, вернуться можно через /sessions.',
    ],
    rows: [[{ text: '🔌 Подключение', callback_data: 'settings:auth' }]],
  };
}

async function pauseDemo({ now, timezone }) {
  const snapshot = await readPauseNoticeSnapshot();
  if (snapshot) {
    return {
      text: [
        `⚠ Кнопка настоящая: если фоновые задачи включены, снимет паузу и вернёт задачи (${snapshot.tasks}).`,
        '',
        formatPauseNotice({ ...snapshot, now, timezone }),
      ],
      rows: [[PAUSE_OFF_BUTTON]],
    };
  }
  return {
    text: [
      'Стопа сейчас нет, кнопку снятия паузы проверить не на чем. Дата и число задач в примере выдуманные.',
      '',
      formatPauseNotice({ since: now - 3 * DAY, now, tasks: 2, timezone }),
    ],
  };
}

const demos = { balance: balanceDemo, provider_credits: creditsDemo, pause_reminder: pauseDemo };

async function monitorNotificationsOff() {
  const config = await loadMonitorConfig().catch(() => null);
  return config?.notifications?.enabled === false || config?.notifications?.mode === 'off';
}

export async function sendNoticeDemos({ send, now, timezone }) {
  const notes = [];
  let sent = 0;
  for (const [kind, { short }] of Object.entries(NOTICE_KINDS)) {
    const label = `🧪 ${short.charAt(0).toUpperCase()}${short.slice(1)}`;
    try {
      if (await isNoticeMuted(kind)) {
        notes.push(`${label}: сейчас отключено, пример не пришлю, верни на этом экране.`);
        continue;
      }
      if (kind === 'balance' && await monitorNotificationsOff()) {
        notes.push(`${label}: сейчас выключено тумблером уведомлений мониторинга (/monitor → ⚙️ Настройки → 🔔 Уведомления), пример не пришлю.`);
        continue;
      }
      const { text, rows } = await demos[kind]({ now, timezone });
      await send([`🧪 Пример. Так выглядит уведомление «${short}».`, ...text].join('\n'), noticeMuteKeyboard(kind, rows));
      sent++;
    } catch (error) {
      console.error(`[msb/notice-demo] ${kind}:`, error.code || error.name);
      notes.push(`${label}: пример не ушёл, нажми «🧪» ещё раз через 10 секунд.`);
    }
  }
  const summary = sent ? `🧪 Прислал примеры ниже: ${sent} из ${Object.keys(demos).length}.` : '🧪 Ни одного примера не прислал.';
  return [summary, ...notes].join('\n');
}
