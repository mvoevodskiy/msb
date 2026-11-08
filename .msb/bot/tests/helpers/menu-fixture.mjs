/**
 * Isolated production ingress: fake Grammy/turn/restart and unavailable native catalog.
 * Native protocol suites explicitly opt in, then install an owned fake CLI before reads.
 * The synthetic HOME owns all bot data; no credential, installer or network setup.
 * Workspace is HOME/workspace so old dirname(base)/projects stays inside HOME.
 * Used by [menu checks](../menu-handlers.test.mjs) and focused form suites.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureClaudeVersion } from './claude-version-fixture.mjs';
import { createBot } from '../../src/telegram/bot.mjs';
import { saveState } from '../../src/state.mjs';
import {isSkillReadCallback} from '../../src/telegram/routes/skills.mjs';
import { installUpdateHook } from '../../../../overlay/bot/ext/install.mjs';

export async function fixture(t, runTurn = async () => ({ ok: true, text: 'fixture' }), { overlay = true, now = Date.now, runtimeProfile = 'msb', claudeCliVersion = '2.1.154', nativeSkills = false, nativeOpenClawSkills = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-menu-'));
  const workspace = path.join(home, 'workspace');
  await fs.mkdir(workspace);
  const previous = { ...process.env };
  let bot;
  process.env.HOME = home; process.env.MSB_BOT_ID = 'default'; process.env.ADMIN_ID = '42';
  process.env.MSB_WORKSPACE_DIR = workspace;
  process.env.MSB_RUNTIME_PROFILE = runtimeProfile;
  process.env.MSB_RUNTIME_ROOT = path.join(home, runtimeProfile === 'jar1' ? '.iia' : '.msb');
  delete process.env.JARVIS_CC_ONLY;
  await fixtureClaudeVersion(home, claudeCliVersion);
  t.after(async () => {
    await bot?.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await fs.rm(home, { recursive: true, force: true });
  });
  const restartRequests = [];
  const markupEdits = [], callbackAnswers = [];
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
      editMessageReplyMarkup: async (chatId, messageId, options) => { markupEdits.push({ chatId, messageId, options }); },
      answerCallbackQuery: async (...args) => { callbackAnswers.push(args); },
      deleteMessage: async (_chat, id) => { deleted.push(id); },
    };
    use(fn) { this.middleware.push(fn); }
    command(name, fn) { this.commands.set(name, fn); }
    on(name, fn) { for (const event of Array.isArray(name) ? name : [name]) this.handlers.set(event, fn); }
    async handleUpdate(update) {
      const event = update.callback_query || update.message;
      const ctx = { from: event.from, chat: event.message?.chat || event.chat, message: update.message,
        callbackQuery: update.callback_query, api: this.api,
        reply: (text, opts, signal) => this.api.sendMessage(ctx.chat.id, text, opts, signal), answerCallbackQuery: async (...args) => { callbackAnswers.push(args); } };
      const text = ctx.message?.text;
      const command = text?.match(/^\/([^@\s]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
      if (command) ctx.match = command[2] || '';
      const handler = ctx.callbackQuery ? this.handlers.get('callback_query:data')
        : command ? this.commands.get(command[1]) || this.handlers.get('message:text') : this.handlers.get(text ? 'message:text' : update.message?.photo ? 'message:photo' : update.message?.video ? 'message:video' : 'message:document');
      const step = (i) => i < this.middleware.length ? this.middleware[i](ctx, () => step(i + 1)) : handler?.(ctx);
      return step(0);
    }
  }
  bot = createBot({ botToken: 'fake', botId: 'default', adminId: 42, workspace, timezone: 'Europe/Moscow' }, { bot: new Harness(), runTurn, readOpenClawSkills: nativeOpenClawSkills ? undefined : async () => [], now, restart: () => restartRequests.push(0) });
  if (overlay) installUpdateHook(Harness, { ADMIN_ID: '42' });
  if (!nativeSkills) bot[Symbol.for('msb.skillsProvider')] = async () => ({ok:false});
  await saveState({ engine: 'cc', extAuthBypass: 'codex', ccSessionId: 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53', dailySpendLimit: 10 });
  const storeFile = path.join(process.env.MSB_RUNTIME_ROOT, 'bots/default/ext-providers.json');
  await fs.writeFile(storeFile, JSON.stringify({ version: 1, active: 'codex', models: { codex: 'gpt-6.1-terra' }, efforts: { codex: 'max' } }));
  const callback = async (data, uid = 42, { chatId = 42, messageId = 1, threadId, waitForRender = true } = {}) => {
    const tasks = Symbol.for('msb.callbackTasks');
    const prior = new Set(bot[tasks] || []);
    await bot.handleUpdate({ callback_query: { id: 'q', data, from: { id: uid }, message: { message_id: messageId, chat: { id: chatId }, ...(threadId ? { message_thread_id: threadId } : {}) } } });
    // UI assertions wait only their own newly detached catalog view. Latency/
    // shutdown tests use waitForRender:false; never drain an older status task.
    if (waitForRender && (['menu:agent','settings:model','settings:model:ver','settings:effort'].includes(data) || isSkillReadCallback(data))) {
      await Promise.allSettled([...(bot[tasks] || [])].filter(p => !prior.has(p)));
    }
  };
  const message = async (text, uid = 42, {waitForRender=true}={}) => {
    const tasks=Symbol.for('msb.callbackTasks'),prior=new Set(bot[tasks] || []);
    await bot.handleUpdate({message:{message_id:99,text,from:{id:uid},chat:{id:42}}});
    if(waitForRender && /^\/skills(?:@\S+)?(?:\s|$)/.test(text))await Promise.allSettled([...(bot[tasks] || [])].filter(p=>!prior.has(p)));
  };
  return { home, workspace, bot, callback, message, markupEdits, callbackAnswers, messages, edits, editOptions, deleted, messageOptions, typingSignals, editSignals, replySignals, storeFile, restartRequests };
}
