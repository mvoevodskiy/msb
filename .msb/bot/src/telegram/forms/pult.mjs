/**
 * Поля Пульта: проверка/сохранение и существующий IPC reload.
 * Вход: [form dispatcher](../forms.mjs); pending и lifecycle принадлежат createBot.
 * [Контракт](../../../tests/reference/parity-forms-contract.txt),
 * [handler tests](../../../tests/pult-input.test.mjs). Backend → [Pult](../../pult/client.mjs).
 */
export const PULT_KINDS = new Set(['pult-password','pult-tg-token','pult-url','pult-listen','pult-session']);
/** Used by routes and deferred callback admission; unrelated form owners survive. */
export function cancelPultInput(pending, chatId, kind) {
  const current = pending.get(chatId);
  if (kind ? current === kind : PULT_KINDS.has(current)) pending.delete(chatId);
}

export async function handlePultInput({ kind, ctx, text, pending, chatId }) {
  pending.delete(chatId);
  const { setEnvKey, deleteEnvKey } = await import('../../env/store.mjs');
  const { pultScreen } = await import('../screens.mjs');
  const { engineStatusSnapshot, submitRequest, waitRequestResult } = await import('../../engines/client.mjs');
  const { readPultSecrets, pultPublicUrl, pultListenHost } = await import('../../pult/client.mjs');
  const { escapeHtml } = await import('../edit.mjs');

  try {
    if (kind === 'pult-password') {
      const pw = text.trim();
      if ([...pw].length < 12) {
        await ctx.reply('Пароль короче 12 символов.');
        return;
      }
      await setEnvKey('PULT_PASSWORD', pw);
    } else if (kind === 'pult-tg-token') {
      const v = text.trim();
      if (v === '-' || v === '') await deleteEnvKey('PULT_TG_TOKEN');
      else await setEnvKey('PULT_TG_TOKEN', v);
    } else if (kind === 'pult-url') {
      const v = text.trim().replace(/\/+$/, '');
      try {
        const u = new URL(v);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      } catch {
        await ctx.reply('Нужен URL вида https://… или http://…');
        return;
      }
      await setEnvKey('PULT_PUBLIC_URL', v);
    } else if (kind === 'pult-listen') {
      const host = text.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host !== '::' && !host.includes(':')) {
        await ctx.reply('Ожидаю IPv4, например 192.168.1.10');
        return;
      }
      await setEnvKey('PULT_HOST', host);
    } else if (kind === 'pult-session') {
      const hours = Number(text.trim());
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
        await ctx.reply('Нужно целое число часов от 1 до 720.');
        return;
      }
      await setEnvKey('PULT_SESSION_HOURS', String(hours));
    }

    let note = 'сохранено';
    try {
      const { id } = await submitRequest('reload-pult', {
        bot_id: process.env.MSB_BOT_ID || 'default',
      });
      const result = await waitRequestResult(id, { timeoutMs: 90_000 });
      note =
        result?.code === 'OK'
          ? 'сохранено, службы обновлены'
          : `сохранено; reload: ${result?.code || 'нет ответа'}`;
    } catch (err) {
      note = `сохранено; reload: ${err.message}`;
    }

    const secrets = await readPultSecrets();
    const { readEnvMap } = await import('../../env/store.mjs');
    const { map } = await readEnvMap();
    const snap = await engineStatusSnapshot();
    const view = pultScreen(
      snap.pult,
      {
        password: map.get('PULT_PASSWORD') || secrets.web.get('PULT_PASSWORD') || '',
        host: map.get('PULT_HOST') || pultListenHost(secrets),
        tgToken: map.get('PULT_TG_TOKEN') || secrets.web.get('PULT_TG_TOKEN') || '',
        publicUrl: map.get('PULT_PUBLIC_URL') || pultPublicUrl(secrets),
        sessionHours: map.get('PULT_SESSION_HOURS') || secrets.web.get('PULT_SESSION_HOURS') || '4',
      },
      escapeHtml(note),
    );
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  } catch (err) {
    await ctx.reply(`Не удалось сохранить: ${err.message}`);
  }
  return;
}
