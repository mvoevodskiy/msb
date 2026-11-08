/**
 * Isolated production Telegram ingress with a fake Grammy transport/turn/restart.
 * The synthetic HOME owns all bot data; no credential, installer or network setup.
 * Used by [menu checks](../menu-handlers.test.mjs) and focused form suites.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot } from '../../src/telegram/bot.mjs';
import { saveState } from '../../src/state.mjs';
import { installUpdateHook } from '../../../../overlay/bot/ext/install.mjs';

export async function fixture(t, runTurn = async () => ({ ok: true, text: 'fixture' }), { overlay = true, now = Date.now } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-menu-'));
  const previous = { ...process.env };
  let bot;
  process.env.HOME = home; process.env.MSB_BOT_ID = 'default'; process.env.ADMIN_ID = '42';
  process.env.MSB_WORKSPACE_DIR = home;
  delete process.env.JARVIS_CC_ONLY;
  t.after(async () => {
    await bot?.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await fs.rm(home, { recursive: true, force: true });
  });
  const restartRequests = [];
  const messages = [], edits = [], editOptions = [], deleted = [], messageOptions = [], typingSignals = [], editSignals = [], replySignals = [];
  class Harness {
    handlers = new Map(); commands = new Map(); middleware = [];
    async start() {}
    async stop() {}
    api = {
      config: { use() {} }, setMyCommands: async () => true,
      sendChatAction: async (_chat, _action, _options, signal) => { typingSignals.push(signal); return true; },
      sendMessage: async (_chat, text, opts, signal) => { messages.push(text); messageOptions.push(opts); replySignals.push(signal); return { message_id: messages.length }; },
      editMessageText: async (_chat, _id, text, options, signal) => { edits.push(text); editOptions.push(options); editSignals.push(signal); },
      answerCallbackQuery: async () => {},
      deleteMessage: async (_chat, id) => { deleted.push(id); },
    };
    use(fn) { this.middleware.push(fn); }
    command(name, fn) { this.commands.set(name, fn); }
    on(name, fn) { for (const event of Array.isArray(name) ? name : [name]) this.handlers.set(event, fn); }
    async handleUpdate(update) {
      const event = update.callback_query || update.message;
      const ctx = { from: event.from, chat: event.message?.chat || event.chat, message: update.message,
        callbackQuery: update.callback_query, api: this.api,
        reply: (text, opts, signal) => this.api.sendMessage(42, text, opts, signal), answerCallbackQuery: async () => {} };
      const text = ctx.message?.text;
      const command = text?.match(/^\/([^@\s]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
      if (command) ctx.match = command[2] || '';
      const handler = ctx.callbackQuery ? this.handlers.get('callback_query:data')
        : command ? this.commands.get(command[1]) || this.handlers.get('message:text') : this.handlers.get(text ? 'message:text' : update.message?.photo ? 'message:photo' : update.message?.video ? 'message:video' : 'message:document');
      const step = (i) => i < this.middleware.length ? this.middleware[i](ctx, () => step(i + 1)) : handler?.(ctx);
      return step(0);
    }
  }
  bot = createBot({ botToken: 'fake', botId: 'default', adminId: 42, workspace: home, timezone: 'Europe/Moscow' }, { bot: new Harness(), runTurn, now, restart: () => restartRequests.push(0) });
  if (overlay) installUpdateHook(Harness, { ADMIN_ID: '42' });
  await saveState({ engine: 'cc', extAuthBypass: 'codex', ccSessionId: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53', dailySpendLimit: 10 });
  const storeFile = path.join(home, '.msb/bots/default/ext-providers.json');
  await fs.writeFile(storeFile, JSON.stringify({ version: 1, active: 'codex', models: { codex: 'gpt-6.1-terra' }, efforts: { codex: 'max' } }));
  const callback = (data, uid = 42) => bot.handleUpdate({ callback_query: { id: 'q', data, from: { id: uid }, message: { message_id: 1, chat: { id: 42 } } } });
  const message = (text, uid = 42) => bot.handleUpdate({ message: { message_id: 99, text, from: { id: uid }, chat: { id: 42 } } });
  return { home, bot, callback, message, messages, edits, editOptions, deleted, messageOptions, typingSignals, editSignals, replySignals, storeFile, restartRequests };
}
