/**
 * Env name → transient value → optional description/skip → one queued save.
 * Вход: [form dispatcher](../forms.mjs); pending и lifecycle принадлежат createBot.
 * [Контракт](../../../tests/reference/parity-forms-contract.txt),
 * [Description contract](../../../tests/reference/parity-env-description-contract.txt),
 * [handler tests](../../../tests/env-description.test.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { validateEnvValue, validateEnvComment, setEnvKey } from '../../env/store.mjs';
import { pendingInputNotice } from '../pending-input.mjs';
import { escapeHtml } from '../edit.mjs';
import { protectedEnvNotice } from '../env-protection.mjs';

export async function handleEnvValueInput({ kind, ctx, text, pending, chatId }) {
  const key = kind.slice(4);
  if (await refuseProtected({ key, ctx, pending, chatId })) return;
  try { validateEnvValue(text.trim()); }
  catch (err) { await ctx.reply(`Не сохранил: ${err.message}`); return; }
  const draft = { key, value:text.trim() };
  pending.advance(chatId, `env-comment:${key}`, draft);
  const prompt = await ctx.reply(`Описание для <code>${escapeHtml(key)}</code> (необязательно, видно тебе и агенту):`, {
    parse_mode:'HTML', reply_markup:new InlineKeyboard().text('Пропустить →','settings:env:skip-comment'),
  });
  if (pending.payload(chatId) === draft) draft.promptMessageId = prompt?.message_id;
  else if (prompt?.message_id) {
    try { await ctx.api.deleteMessage(chatId,prompt.message_id); } catch { /* late own prompt after cancel/replace/stop */ }
  }
}

export async function handleEnvNameInput({ ctx, text, pending, chatId }) {
  const key = text.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    await ctx.reply('Имя ключа: только A-Z, цифры и _.');
    return;
  }
  if (await refuseProtected({ key, ctx, pending, chatId })) return;
  pending.advance(chatId, `env:${key}`);
  await ctx.reply(`Ок. Пришли значение для <code>${key}</code>.`, { parse_mode: 'HTML' });
  return;
}

async function refuseProtected({ key, ctx, pending, chatId }) {
  const notice = protectedEnvNotice(key);
  if (!notice) return false;
  pending.delete(chatId);
  await ctx.reply(notice.text, { parse_mode: 'HTML', reply_markup: notice.keyboard });
  return true;
}

export async function handleEnvCommentInput({ctx,text,pending,chatId}) {
  const comment = text.trim() || undefined;
  try { validateEnvComment(comment); }
  catch (err) { await ctx.reply(`Не сохранил: ${err.message}`); return; }
  return completeEnvInput({ctx,pending,chatId,comment});
}

export async function skipEnvComment({ctx,pending,chatId}) {
  if (!pending.get(chatId)?.startsWith('env-comment:')) return;
  const notice = pendingInputNotice(pending.read(chatId), '');
  if (notice) { pending.delete(chatId); await ctx.reply(notice); return; }
  const draft = pending.payload(chatId);
  if (!draft || !draft.promptMessageId || ctx.callbackQuery?.message?.message_id !== draft.promptMessageId) return;
  return completeEnvInput({ctx,pending,chatId});
}

async function completeEnvInput({ctx,pending,chatId,comment}) {
  const draft = pending.payload(chatId);
  if (!draft || pending.get(chatId) !== `env-comment:${draft.key}`) return;
  pending.delete(chatId);
  if (draft.promptMessageId) {
    try { await ctx.api.deleteMessage(chatId,draft.promptMessageId); } catch { /* only own prompt, best effort */ }
  }
  try { await setEnvKey(draft.key,draft.value,process.env,{comment}); }
  catch (err) { await ctx.reply(`Не сохранил: ${err.message}`); return; }
  const note = comment ? `\n📝 ${escapeHtml(comment)}` : '';
  await ctx.reply(`Сохранил <code>${escapeHtml(draft.key)}</code> в .env бота. Это не проверка подключения сервиса. Для параметров запуска нужен перезапуск бота.${note}`, {parse_mode:'HTML'});
}
