/**
 * Текстовые формы до обычного prompt/очереди. Один dispatcher, не второй путь
 * входящих сообщений: [createBot](./bot.mjs) владеет pending и принимает результат.
 * Auth → [forms/auth](./forms/auth.mjs), env → [forms/env](./forms/env.mjs),
 * Pult → [forms/pult](./forms/pult.mjs); остальные короткие input adapters ниже.
 * Timezone остаётся после reply-stop в createBot, чтобы сохранить прежний приоритет.
 * [Контракт](../../tests/reference/parity-forms-contract.txt), [проверки](../../tests/menu-handlers.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, workspaceDir } from '../paths.mjs';
import { updateState } from '../state.mjs';
import { escapeHtml } from './edit.mjs';
import { handleAuthInput } from './forms/auth.mjs';
import { handleEnvNameInput, handleEnvValueInput } from './forms/env.mjs';
import { handlePultInput } from './forms/pult.mjs';

const HANDLERS = {
  'auth-token': handleAuthInput, 'env-key-name': handleEnvNameInput,
  'feedback': handleFeedback, 'new-project': handleProject,
  'bot-token': handleBotToken, 'mon-source': handleSource,
};
const PULT_KINDS = new Set(['pult-password','pult-tg-token','pult-url','pult-listen','pult-session']);
export async function handleFormInput(options) {
  const {kind,ctx} = options;
  const handler = kind?.startsWith('env:') ? handleEnvValueInput
    : PULT_KINDS.has(kind) ? handlePultInput : Object.hasOwn(HANDLERS, kind) ? HANDLERS[kind] : undefined;
  if (!handler) return false;
  await handler({...options, chatId:ctx.chat.id});
  return true;
}

async function handleFeedback({ ctx,text,pending,chatId }) {
  pending.delete(chatId);
  const file = path.join(workspaceDir(), 'ops', 'feedback.md');
  ensureDir(path.dirname(file));
  await fs.appendFile(file, `\n## ${new Date().toISOString()}\n\n${text}\n`);
  await ctx.reply('Спасибо, записал.');
  return;
}

async function handleProject({ ctx,text,pending,chatId }) {
  pending.delete(chatId);
  const name = text.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!name) {
    await ctx.reply('Имя не подошло. Только латиница, цифры, -_.');
    return;
  }
  const dir = path.join(process.env.HOME || '', 'projects', name);
  await fs.mkdir(dir, { recursive: true });
  await updateState((s) => { s.activeProject = name; return s; });
  await ctx.reply(`✔ Проект <code>${name}</code> создан и выбран. Переключение cwd в open-core пока не подключено.`, { parse_mode: 'HTML' });
  return;
}

async function handleBotToken({ ctx,text,pending,chatId,cfg }) {
  pending.delete(chatId);
  await ctx.reply('⏳ Ставлю бота через bot-ctl…');
  const { addBot } = await import('../bots/manage.mjs');
  const res = await addBot(text.trim(), { ownerId: cfg.adminId });
  if (res.ok) {
    await ctx.reply(`✔ Служба бота <b>${res.botId}</b> создана и запущена. Ответ в Telegram ещё нужно проверить.`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply(`Не удалось добавить бота: ${res.error}`);
  }
  return;
}

async function handleSource({ ctx,text,pending,chatId }) {
  pending.delete(chatId);
  const { addSourceFromInput } = await import('../monitor/config.mjs');
  const res = await addSourceFromInput(text);
  if (!res.ok) {
    await ctx.reply(res.error);
    return;
  }
  await ctx.reply(
    res.added
      ? `✔ Источник <b>${res.type}</b>: ${res.name}`
      : `Уже был: <b>${res.type}</b> ${res.name}`,
    { parse_mode: 'HTML' },
  );
  return;
}

