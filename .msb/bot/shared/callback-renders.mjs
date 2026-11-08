/**
 * Latest incoming UI read/view and ordered delivery per bot/chat; no profile/data I/O.
 * [Core router](../src/telegram/router.mjs) and [overlay admission](../../../overlay/bot/ext/integration/update-hook.mjs)
 * share actual incoming-event scopes across awaits/detached continuations.
 * [Skills command](../src/telegram/bot.mjs) uses its real message, without synthetic callbacks.
 * Read observers/backoff may abort; an accepted Telegram edit drains before the next view.
 * [API policy](../src/telegram/presentation-api.mjs) separates those lifetimes.
 * [Bot stop](../src/telegram/bot.mjs) drains work; [checks](../tests/callback-refresh.test.mjs).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
const states = new WeakMap(), events = new WeakMap(), transports = new WeakMap();
const context = new AsyncLocalStorage();
const TASKS = Symbol.for('msb.callbackTasks');
function stateFor(bot) {
  if (!states.has(bot)) states.set(bot, { chats: new Map(), deliveries: new Map(), stopped: false });
  return states.get(bot);
}

function beginViewRender(bot, event, chat) {
  const known = events.get(event);
  if (known?.bot === bot) return known;
  const state = stateFor(bot);
  state.chats.get(chat)?.controller.abort();
  const controller = new AbortController();
  const scope = { bot, chat, controller, signal: controller.signal,
    isCurrent: () => !state.stopped && !controller.signal.aborted && state.chats.get(chat) === scope,
    render: operation => {
      const previous = state.deliveries.get(chat) || Promise.resolve();
      const delivery = previous.catch(() => {}).then(() => scope.isCurrent() ? operation() : undefined);
      state.deliveries.set(chat, delivery);
      const done = () => { if (state.deliveries.get(chat) === delivery) state.deliveries.delete(chat); };
      delivery.then(done, done);
      return delivery;
    },
  };
  if (state.stopped || chat == null) controller.abort();
  else state.chats.set(chat, scope);
  // Keep the selected view current after its handler returns. Provider login can
  // still update that view asynchronously, until the next user navigation.
  events.set(event, scope);
  return scope;
}
export function beginCallbackRender(bot,query) {return beginViewRender(bot,query,query.message?.chat?.id);}
/** A detached command read owns its real incoming message and the same navigation/stop fence. */
export function beginCommandRender(bot,message) {return beginViewRender(bot,message,message.chat?.id);}
export function runCallbackScope(scope, operation) { return context.run(scope, operation); }
export function currentCallbackRender(bot, chatId) {
  const scope = context.getStore();
  return scope?.bot === bot && scope.chat === chatId ? scope : null;
}

/** Metadata signal; the API transformer supplies a fresh bounded signal per attempt. */
export function callbackTransportSignal(scope) {
  const signal = new AbortController().signal;transports.set(signal, scope);return signal;
}
export function callbackTransportScope(signal) { return transports.get(signal); }

export function cancelCallbackRenders(bot, chatId) {
  const state = stateFor(bot);
  for (const [chat, scope] of state.chats) {
    if (chatId !== undefined && chat !== chatId) continue;
    scope.controller.abort();state.chats.delete(chat);
  }
}
export function openCallbackRenders(bot) { stateFor(bot).stopped = false; }
export function stopCallbackRenders(bot) { stateFor(bot).stopped = true;cancelCallbackRenders(bot); }
export function trackCallbackTask(bot, task) {
  if (!bot[TASKS]) Object.defineProperty(bot, TASKS, { value: new Set() });
  const tasks = bot[TASKS];tasks.add(task);
  task.then(() => tasks.delete(task), () => tasks.delete(task));
}
export async function drainCallbackTasks(bot) {
  while (true) {
    const pending = [...(bot[TASKS] || []), ...stateFor(bot).deliveries.values()];
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}
