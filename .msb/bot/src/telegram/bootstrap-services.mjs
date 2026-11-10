/**
 * Final Codex introduction card and its one-step, per-bot service input.
 * [Introduction](../agent/codex-bootstrap.mjs) records eligibility; [bot](./bot.mjs)
 * offers the card after the reply. Callbacks and text use the [router](./router.mjs)
 * and [forms](./forms.mjs); the only value writer is [env store](../env/store.mjs).
 * [Old reference and ingress tests](../../tests/codex-bootstrap-services.test.mjs).
 */
import { codexBootstrapScope } from '../agent/codex-bootstrap.mjs';
import { readEnvMap, setEnvKey } from '../env/store.mjs';
import { resolveSttConfig } from '../media/stt.mjs';
import { statePath } from '../paths.mjs';
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { BOOTSTRAP_SERVICE_INPUT } from './pending-input.mjs';
import { presentationSignal } from './presentation-api.mjs';
import { UNHANDLED } from './routes/shared.mjs';

// Old bh/fh (master 00f081f, blob 73aa9e7e, lines 111414–111509).
// These labels describe intended uses. A checkmark means a value is configured.
const services = new Map([
  ['OPENROUTER_API_KEY', ['🤖 OpenRouter', 'скоринг, дайджест, брифинг']],
  ['X_BEARER_TOKEN', ['🐦 X/Twitter', 'мониторинг Twitter']],
  ['DEEPGRAM_API_KEY', ['🎤 Голосовые', 'распознавание голоса']],
  ['VOYAGE_API_KEY', ['🔍 Поиск', 'семантический поиск по памяти']],
  ['GITHUB_TOKEN', ['🐙 GitHub', 'работа с репозиториями']],
  ['SUPABASE_URL', ['🗄 Supabase', 'база данных']],
  ['RAILWAY_TOKEN', ['🚀 Railway', 'деплой бэкенда']],
  ['VERCEL_TOKEN', ['🌐 Vercel', 'деплой фронтенда']],
]);
const prefix = 'svc_setup:';
const settingsHint = '/settings → 🔑';
const skip = {
  text: 'Готово! Сервисы можно добавить в любое время через ' + settingsHint,
  keyboard: { inline_keyboard: [] },
};

async function serviceCard() {
  const { map } = await readEnvMap();
  const stt = await resolveSttConfig().catch(() => null);
  const configured = [], missing = [], rows = [];
  for (const [key, [label, description]] of services) {
    const set = key === 'DEEPGRAM_API_KEY' ? stt?.apiKey : (process.env[key] ?? map.get(key))?.trim();
    if (set) {
      configured.push('✔ ' + label);
      continue;
    }
    missing.push(label + ' — ' + description);
    if (!rows.length || rows.at(-1).length === 3) rows.push([]);
    rows.at(-1).push({ text: label, callback_data: prefix + key });
  }
  rows.push([{ text: 'Пропустить', callback_data: prefix + 'skip' }]);
  const sections = ['<b>Какие сервисы подключить?</b>'];
  if (configured.length) sections.push(configured.join('\n'));
  sections.push(missing.join('\n'));
  return { text: sections.join('\n\n'), keyboard: { inline_keyboard: rows } };
}

function topic(ctx) {
  const id = (ctx.message || ctx.callbackQuery?.message)?.message_thread_id;
  return id > 1 ? id : undefined;
}

function scopeOf(ctx) {
  return codexBootstrapScope(ctx.chat?.id, ctx.from?.id, topic(ctx));
}

function reply(ctx, { text, keyboard }) {
  const thread = topic(ctx);
  return ctx.reply(text, {
    parse_mode: 'HTML', reply_markup: keyboard, ...(thread ? { message_thread_id: thread } : {}),
  }, presentationSignal(AbortSignal.timeout(15_000)));
}

const delivering = new Set();
const sent = new Map();

export async function deliverBootstrapServices(ctx) {
  const file = statePath();
  const scope = scopeOf(ctx);
  if (!scope || delivering.has(file)) return;
  delivering.add(file);
  try {
    const { state } = await loadState();
    if (state.servicesSetupShown || state.codexServiceSetup?.scope !== scope ||
        state.extAuthBypass !== 'codex' || state.engine === 'oc') return;
    if (sent.get(file) !== scope) {
      await reply(ctx, await serviceCard());
      sent.set(file, scope);
    }
    await updateState(current => {
      if (current.codexServiceSetup?.scope !== scope) return NO_STATE_WRITE;
      current.servicesSetupShown = true;
      delete current.codexServiceSetup;
      return current;
    });
    sent.delete(file);
  } catch {
    // After a write failure, keep the in-process receipt so /start only retries the state write.
    console.error('[msb/bot] service setup card delivery failed');
  } finally {
    delivering.delete(file);
  }
}

export function bootstrapServiceOwnsInput(ctx, draft) {
  return Boolean(draft && draft.scope === scopeOf(ctx));
}

export async function handleBootstrapServiceRoute({ ctx, chatId, msgId, data, pending, show, signal }) {
  if (!data.startsWith(prefix)) return UNHANDLED;
  const scope = scopeOf(ctx);
  if (!scope || !msgId || signal.aborted) return;
  const action = data.slice(prefix.length);
  const render = view => show({ ...view, replyThreadId: topic(ctx) });
  if (action === 'skip' || action === 'back') {
    const draft = pending.payload(chatId);
    if (pending.get(chatId) === BOOTSTRAP_SERVICE_INPUT &&
        draft?.scope === scope && draft.messageId === msgId) pending.delete(chatId);
    return render(action === 'skip' ? skip : await serviceCard());
  }
  const service = services.get(action);
  if (!service) return;

  const [label] = service;
  const prompt = {
    text: '<b>' + label + '</b>\n\nВставь ключ <code>' + action + '</code>:',
    keyboard: { inline_keyboard: [[{ text: '« Назад', callback_data: prefix + 'back' }]] },
  };
  // Telegram may show the prompt before its API acknowledges the edit.
  const draft = { key: action, scope, messageId: msgId };
  pending.set(chatId, BOOTSTRAP_SERVICE_INPUT);
  pending.advance(chatId, BOOTSTRAP_SERVICE_INPUT, draft);
  try {
    const result = await render(prompt);
    if (result?.message_id) draft.messageId = result.message_id;
  } catch (error) {
    if (pending.payload(chatId) === draft) pending.delete(chatId);
    throw error;
  }
}

export async function handleBootstrapServiceInput({ ctx, text, pending, chatId }) {
  const { key } = pending.payload(chatId);
  pending.delete(chatId);
  const value = text.trim();
  if (value.length < 5) {
    await reply(ctx, { text: 'Ключ слишком короткий. Повтори через ' + settingsHint + '.' });
    return;
  }
  try {
    await setEnvKey(key, value);
  } catch {
    await reply(ctx, { text: 'Не удалось сохранить ключ. Повтори через ' + settingsHint + '.' });
    return;
  }

  const [label] = services.get(key);
  await reply(ctx, { text: '✔ ' + label + ' — значение сохранено.' }).catch(() => {});
  try { await reply(ctx, await serviceCard()); }
  catch { console.error('[msb/bot] saved service card refresh failed'); }
}
