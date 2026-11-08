/**
 * Ввод Claude auth: сохранение и запрос перезапуска, без собственного polling.
 * Вход: [form dispatcher](../forms.mjs); pending и lifecycle принадлежат createBot.
 * [Контракт](../../../tests/reference/parity-forms-contract.txt),
 * [handler tests](../../../tests/auth-input.test.mjs).
 */
import { updateState } from '../../state.mjs';

export async function handleAuthInput({ ctx, text, pending, chatId, restart }) {
  const token = text.replace(/\s+/g, '');
  // Old token-specific privacy behavior; env-value messages are not deleted.
  try { await ctx.api.deleteMessage(chatId, ctx.message.message_id); } catch { /* best effort */ }
  if ((!token.startsWith('sk-') && token.length < 50) || token.length < 20) {
    await ctx.reply('Не похоже на токен. Запусти в терминале: <code>claude setup-token</code>', { parse_mode: 'HTML' });
    return;
  }
  // setup-token emits sk-ant-oat*, which is OAuth, not an Anthropic API key.
  // A recognized prefix only selects the existing storage route, not live auth.
  const key = token.startsWith('sk-ant-api') ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  const { setEnvKey } = await import('../../env/store.mjs');
  try {
    await setEnvKey(key, token);
    process.env[key] = token;
    if (key === 'ANTHROPIC_API_KEY') process.env.MSB_ANTHROPIC_API_KEY = token;
    await updateState((s) => {
      s.authMode = 'subscription';
      s.hasSubscriptionAuth = true;
      return s;
    });
  } catch (err) { await ctx.reply(`Токен не сохранён: ${err.message}`); return; }
  pending.delete(chatId);
  await ctx.reply('Токен сохранён. Перезапускаюсь…');
  restart();
}
