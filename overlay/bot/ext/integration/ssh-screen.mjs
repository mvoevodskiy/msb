/**
 * Статус и инструкция SSH. Чтение состояния принадлежит local-ssh.mjs.
 * Навигация: [Обвязка](../README.md).
 */
import { getLocalSshHost, handleLocalConstructorRequest, constructorBaseUrl } from '../local-ssh.mjs';
import { editOrReply } from './shared.mjs';

export async function showLocalAwareSshHome(bot, chatId, messageId, { manage = false } = {}) {
  const host = getLocalSshHost();
  const base = constructorBaseUrl();
  let statusText = '';
  let ok = false;
  try {
    if (host) {
      const res = await handleLocalConstructorRequest(`${base || 'http://local'}/api/ssh/status`, { method: 'GET' });
      const data = await res.json();
      ok = !!data?.ok;
      if (ok) {
        statusText =
          `🖥 Сервер: <code>${data.vps_ip}</code> (локальный режим)\n` +
          `🔑 Ключей: ${data.keys_count}\n` +
          `🌐 Разрешённых IP: ${(data.allowed_ips || []).length}\n`;
        if ((data.allowed_ips || []).length) {
          statusText += '\n<b>Открытые IP:</b>\n';
          for (const ip of data.allowed_ips.slice(0, 10)) statusText += `  • <code>${ip}</code>\n`;
        }
        statusText += `\nПодключение: <code>ssh client@${data.vps_ip}</code>`;
      } else {
        statusText = `⚠️ ${data?.error || 'Не удалось получить локальный статус'}`;
      }
    } else {
      // без локального IP — штатный путь через constructor (может упасть на LAN)
      const syncUrl = process.env.SYNC_URL || process.env.MSB_SYNC_URL || '';
      const syncKey = process.env.SYNC_KEY || process.env.MSB_SYNC_KEY || '';
      if (!syncUrl || !syncKey || !base) {
        statusText = 'Статус SSH в меню не настроен. Сам SSH-доступ этим экраном не проверяется.';
      } else {
        const res = await fetch(`${base}/api/ssh/status`, {
          headers: { Authorization: `Bearer ${syncKey}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(20000),
        });
        const data = await res.json().catch(() => ({}));
        ok = !!data?.ok;
        if (ok) {
          statusText =
            `🖥 Сервер: <code>${data.vps_ip}</code>\n` +
            `🔑 Ключей: ${data.keys_count}\n` +
            `🌐 Разрешённых IP: ${(data.allowed_ips || []).length}\n`;
          if ((data.allowed_ips || []).length) {
            statusText += '\n<b>Открытые IP:</b>\n';
            for (const ip of data.allowed_ips.slice(0, 10)) statusText += `  • <code>${ip}</code>\n`;
          }
          statusText += `\nПодключение: <code>ssh client@${data.vps_ip}</code>`;
        } else {
          statusText =
            `⚠️ ${data?.error || 'Не удалось получить статус'}\n\n` +
            'На внутренней сети конструктор не достучится по внешнему IP. Задай «🖧 Локальный SSH IP».';
        }
      }
    }
  } catch (err) {
    statusText =
      `⚠️ ${String(err?.message || err).slice(0, 200)}\n\n` +
      'Задай «🖧 Локальный SSH IP», если сервер во внутренней сети.';
  }

  const rows = [];
  if (ok && manage) {
    rows.push([{ text: '🔑 Добавить SSH ключ', callback_data: 'settings:ssh:add-key' }]);
    rows.push([{ text: '📋 Показать ключи', callback_data: 'settings:ssh:list-keys' }]);
    rows.push([{ text: '🌐 Открыть IP', callback_data: 'settings:ssh:add-ip' }]);
    rows.push([{ text: '👁 Показать IP', callback_data: 'settings:ssh:list-ips' }]);
  } else {
    rows.push([{ text: '🔄 Обновить', callback_data: 'settings:ssh' }]);
  }
  rows.push([
    {
      text: host ? `🖧 Локальный IP: ${host}` : '🖧 Локальный SSH IP',
      callback_data: 'ext:ssh:local',
    },
  ]);
  rows.push([{ text: '❓ Инструкция', callback_data: 'settings:ssh:help' }]);
  rows.push([{ text: '« Назад', callback_data: 'settings:extras' }]);

  const text = `<b>🔐 SSH доступ к серверу</b>\n\n${statusText}`;
  await editOrReply(bot, chatId, messageId, text, { inline_keyboard: rows });
}

export function showSshHelp(bot, chatId, messageId) {
  const text = [
    '<b>🔐 Как подключиться по SSH</b>',
    '',
    '1. Открой терминал на компьютере, где настроен твой SSH-ключ.',
    '2. Подключись по своему SSH-псевдониму или командой <code>ssh client@IP_СЕРВЕРА</code>. Используй адрес, пользователя и порт своего сервера.',
    '3. Если подключение не открывается, используй консоль хостера или уже настроенный способ доступа.',
    '',
    '«Локальный SSH IP» задаёт адрес для проверки статуса из внутренней сети.',
  ].join('\n');
  return editOrReply(bot, chatId, messageId, text,
    { inline_keyboard: [[{ text: '« Назад', callback_data: 'settings:ssh' }]] });
}
