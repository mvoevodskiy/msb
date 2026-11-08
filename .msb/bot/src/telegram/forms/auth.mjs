/**
 * Ввод Claude auth: сохранение и запрос перезапуска, без собственного polling.
 * Вход: [form dispatcher](../forms.mjs); pending и lifecycle принадлежат createBot.
 * [Контракт](../../../tests/reference/parity-forms-contract.txt),
 * [handler tests](../../../tests/menu-handlers.test.mjs).
 */
import { updateState } from '../../state.mjs';

export async function handleAuthInput({ ctx, text, pending, chatId, restart }) {
  const token = text.trim();
  const { setEnvKey } = await import('../../env/store.mjs');
  try {
    await setEnvKey(token.startsWith('sk-ant-') ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN', token);
    await saveAuthToken(token);
  } catch (err) { await ctx.reply(`Токен не сохранён: ${err.message}`); return; }
  pending.delete(chatId);
  await ctx.reply('Токен сохранён. Перезапускаюсь…');
  restart();
  return;
}

async function saveAuthToken(raw) {
  const token = raw.trim();
  if (token.startsWith('sk-ant-')) {
    process.env.ANTHROPIC_API_KEY = token;
    process.env.MSB_ANTHROPIC_API_KEY = token;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  await updateState((s) => {
    s.authMode = 'subscription';
    s.hasSubscriptionAuth = true;
    return s;
  });
}
