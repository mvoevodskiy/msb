/**
 * Системные настройки, Пульт и перезапуск.
 * Pult starts/Back/presets own [text forms](../forms/pult.mjs); other pending
 * kinds remain owned by their routes. [Checks](../../../tests/pult-input.test.mjs).
 * Навигация: [Telegram](../README.md).
 */
import { spawn } from 'node:child_process';
import { InlineKeyboard } from 'grammy';
import {
  extrasScreen,
  pultListenScreen,
  pultScreen,
  restartConfirmScreen,
  sshUnavailableScreen,
  updatesScreen,
} from '../screens.mjs';
import { parsePultStatus } from '../../pult/status.mjs';
import { cancelPultInput } from '../forms/pult.mjs';
import { escapeHtml } from '../edit.mjs';
import {
  engineStatusSnapshot,
  refreshEngineStatus,
  submitRequest,
  waitRequestResult,
} from '../../engines/client.mjs';
import { UNHANDLED } from './shared.mjs';

export async function handleSystemRoute({ data, show, chatId, bot, pending, signal }) {
  // —— settings tree ——
  if (data === 'settings:extras') return show(extrasScreen());

  // —— Пульт ——
  if (data === 'pult:refresh') {
    try {
      const { buildPultCommandKeyboard } = await import('../../pult/client.mjs');
      return show(await buildPultCommandKeyboard());
    } catch (err) {
      return show({
        text: `<b>🖥 Пульт</b>\n\nНе удалось обновить кнопки: ${escapeHtml(err.message)}`,
        keyboard: new InlineKeyboard().text('🔄 Ещё раз', 'pult:refresh'),
      });
    }
  }

  if (data.startsWith('settings:pult')) {
    const { readPultSecrets, pultPublicUrl, pultListenHost } = await import('../../pult/client.mjs');
    const { readEnvMap } = await import('../../env/store.mjs');
    const loadPultCfg = async () => {
      const secrets = await readPultSecrets();
      const { map } = await readEnvMap();
      const password = map.get('PULT_PASSWORD') || secrets.web.get('PULT_PASSWORD') || '';
      const tgToken = map.get('PULT_TG_TOKEN') || secrets.web.get('PULT_TG_TOKEN') || '';
      const sessionHours = map.get('PULT_SESSION_HOURS') || secrets.web.get('PULT_SESSION_HOURS') || '4';
      return {
        password,
        host: map.get('PULT_HOST') || pultListenHost(secrets),
        tgToken,
        publicUrl: map.get('PULT_PUBLIC_URL') || pultPublicUrl(secrets),
        sessionHours,
      };
    };
    const showPult = async (note = '', snapshot) => {
      const snap = snapshot ?? await engineStatusSnapshot();
      return show(pultScreen(snap.pult, await loadPultCfg(), note));
    };
    const reloadIfNeeded = async () => {
      try {
        const { id } = await submitRequest('reload-pult', {
          bot_id: process.env.MSB_BOT_ID || 'default',
        });
        const result = await waitRequestResult(id, { timeoutMs: 90_000 });
        return result?.code === 'OK'
          ? 'настройки применены'
          : `reload: <code>${escapeHtml(result?.code || 'нет ответа')}</code>`;
      } catch (err) {
        return `reload: ${escapeHtml(err.message)}`;
      }
    };

    if (data === 'settings:pult') {
      cancelPultInput(pending, chatId);
      return showPult();
    }
    if (data === 'settings:pult:refresh') {
      // Deferred input exit belongs to router admission, before any await.
      try {
        const { result, snapshot } = await refreshEngineStatus({ signal });
        if (!result) return showPult('Обновление статуса не подтверждено: нет ответа помощника.', { pult: null });
        if (result.code !== 'OK') return showPult(`Не удалось обновить статус: <code>${escapeHtml(result.code)}</code>.`, { pult: null });
        if (!parsePultStatus(snapshot.pult).known) return showPult('Помощник не вернул полный статус Пульта.', { pult: null });
        return showPult('', snapshot);
      } catch (err) {
        if (signal?.aborted) return;
        return showPult(`Не удалось обновить статус: ${escapeHtml(err.message)}`, { pult: null });
      }
    }
    if (data === 'settings:pult:on' || data === 'settings:pult:off') {
      const action = data === 'settings:pult:on' ? 'enable-pult' : 'disable-pult';
      try {
        const { id } = await submitRequest(action, {
          bot_id: process.env.MSB_BOT_ID || 'default',
        });
        const result = await waitRequestResult(id, { timeoutMs: 90_000 });
        const note = result
          ? `${action}: <code>${escapeHtml(result.code)}</code>${
              result.detail?.hint ? `\n${escapeHtml(String(result.detail.hint))}` : ''
            }${result.detail?.reason ? ` (${escapeHtml(String(result.detail.reason))})` : ''}`
          : `⚠️ ${action}: нет ответа helper`;
        return showPult(note);
      } catch (err) {
        return showPult(`${action} ошибка: ${escapeHtml(err.message)}`);
      }
    }
    if (data === 'settings:pult:password') {
      pending.set(chatId, 'pult-password');
      return show({
        text: `<b>🔑 Пароль Пульта</b>\n\nПришли пароль (≥12 символов). Сохраню в .env бота и перезапущу службы, если Пульт включён.`,
        keyboard: new InlineKeyboard().text('« Назад', 'settings:pult'),
      });
    }
    if (data === 'settings:pult:tg-token') {
      pending.set(chatId, 'pult-tg-token');
      return show({
        text: `<b>🤖 Бот тревог Пульта</b>\n\nНеобязателен: панель открывается через <code>/pult</code> из любого MSB-бота.\nТокен нужен только для тревог и сводки 08:00.\n\nПришли токен от @BotFather или <code>-</code>, чтобы сбросить.`,
        keyboard: new InlineKeyboard().text('« Назад', 'settings:pult'),
      });
    }
    if (data === 'settings:pult:url') {
      pending.set(chatId, 'pult-url');
      return show({
        text: `<b>🔗 Публичный URL Пульта</b>\n\nАдрес, который попадает в кнопки /pult и Mini App.\nПример: <code>https://pult.example.com</code> или <code>http://192.168.1.10:8791</code>`,
        keyboard: new InlineKeyboard().text('« Назад', 'settings:pult'),
      });
    }
    if (data === 'settings:pult:session') {
      pending.set(chatId, 'pult-session');
      return show({
        text: `<b>⏱ Сессия браузера</b>\n\nСколько часов жить cookie после входа (пароль, Mini App или одноразовая ссылка).\nПо умолчанию <b>4</b>. Допустимо 1…720.\n\nПришли число часов.`,
        keyboard: new InlineKeyboard()
          .text('4 ч', 'settings:pult:session:set:4')
          .text('12 ч', 'settings:pult:session:set:12')
          .text('24 ч', 'settings:pult:session:set:24')
          .row()
          .text('« Назад', 'settings:pult'),
      });
    }
    if (data.startsWith('settings:pult:session:set:')) {
      cancelPultInput(pending, chatId, 'pult-session');
      const hours = data.slice('settings:pult:session:set:'.length);
      const { setEnvKey } = await import('../../env/store.mjs');
      await setEnvKey('PULT_SESSION_HOURS', hours);
      const note = await reloadIfNeeded();
      return showPult(`Сессия: <b>${escapeHtml(hours)} ч</b>\n${note}`);
    }
    if (data === 'settings:pult:listen') {
      cancelPultInput(pending, chatId, 'pult-listen');
      const cfg = await loadPultCfg();
      return show(pultListenScreen(cfg.host));
    }
    if (data === 'settings:pult:listen:custom') {
      pending.set(chatId, 'pult-listen');
      return show({
        text: `<b>✏️ Свой IP прослушивания</b>\n\nПришли IPv4 (например <code>192.168.1.10</code>).`,
        keyboard: new InlineKeyboard().text('« Назад', 'settings:pult:listen'),
      });
    }
    if (data.startsWith('settings:pult:listen:set:')) {
      cancelPultInput(pending, chatId, 'pult-listen');
      const host = data.slice('settings:pult:listen:set:'.length);
      const { setEnvKey } = await import('../../env/store.mjs');
      await setEnvKey('PULT_HOST', host);
      const note = await reloadIfNeeded();
      return showPult(`Слушает: <code>${escapeHtml(host)}</code>\n${note}`);
    }
    return UNHANDLED;
  }

  if (data === 'settings:restart') return show(restartConfirmScreen());
  if (data === 'settings:restart:do') {
    await bot.api.sendMessage(chatId, 'Запускаю перезапуск бота…');
    setTimeout(() => restartSelf(() => bot.api.sendMessage(chatId, 'Не удалось запустить перезапуск. Служба осталась в прежнем состоянии.').catch(() => {})), 400);
    return;
  }
  if (data === 'settings:ssh') return show(sshUnavailableScreen());
  if (data === 'settings:updates') return show(await updatesScreen());
  return UNHANDLED;
}

function restartSelf(onError) {
  try {
    const child = spawn('sudo', ['-n', 'bot-ctl.sh', 'restart', process.env.MSB_BOT_ID || 'default'], {
      detached: true, stdio: 'ignore',
    });
    child.once('error', onError);
    child.once('exit', (code) => { if (code) onError(); });
    child.unref();
  } catch { onError(); }
}
