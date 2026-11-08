/**
 * Owner boundary, отмена форм и передача события core.
 * Admission failure/cross-chat checks: [input boundary](../tests/input-boundary.test.mjs).
 * Навигация: [Обвязка](../README.md).
 */
import { beginCallbackRender, runCallbackScope } from '../../shared/callback-renders.mjs';
import { registerEngineProviderView } from '../engine-menu.mjs';
import { registerCompactProvider } from '../compact-codex.mjs';
import { clearPendingAuth } from '../auth.mjs';
import { clearPendingLocalIp } from '../local-ssh.mjs';
import { handleCallback } from './callbacks.mjs';
import { handleAuthMessage } from './text-input.mjs';
import { EXT_MARKER } from './shared.mjs';

export function installUpdateHook(BotClass, env = process.env) {
  registerEngineProviderView(BotClass, env);
  registerCompactProvider(BotClass, env);
  const ownerId = Number(env.ADMIN_ID || env.OWNER_USER_ID || '0');
  const closedCore = env.MSB_USE_CLOSED_CORE === '1';
  const origHandleUpdate = BotClass.prototype.handleUpdate;
  BotClass.prototype.handleUpdate = async function handleUpdateExt(update, webhookReplyEnvelope) {
    const event = update?.callback_query || update?.message;
    if (!Number.isFinite(ownerId) || ownerId <= 0 || Number(event?.from?.id) !== ownerId) {
      return origHandleUpdate.call(this, update, webhookReplyEnvelope);
    }
    try {
      if (update?.callback_query) {
        const render = beginCallbackRender(this, event);
        const startsForm = [
          'settings:auth:switch-sub', 'setup:subscription', 'settings:env:add',
          'settings:tz', 'menu:newproject', 'mon:add-hint', 'settings:bots:add', 'ext:ssh:local:edit',
          'settings:pult:password', 'settings:pult:tg-token', 'settings:pult:url',
          'settings:pult:session', 'settings:pult:listen:custom',
        ].includes(event.data) || /^(?:settings:env:quick:|ext:auth:|ext:conn:set:|settings:conn:set:|settings:engine:set:)/.test(event.data || '');
        if (startsForm || ['menu:back', 'menu:close', 'menu:settings', 'menu:agent', 'settings:back', 'settings:env', 'settings:env:cancel', 'settings:auth', 'settings:conn', 'ext:conn', 'ext:ssh:local', 'mon:back', 'settings:bots:cancel'].includes(event.data)) {
          const chatId = event.message?.chat?.id;
          if (chatId != null) {
            clearPendingAuth(event.from.id, { chatId });
            clearPendingLocalIp(event.from.id, { chatId });
            this[Symbol.for('msb.cancelPendingInput')]?.(chatId);
          }
        }
        const handled = await runCallbackScope(render, () => handleCallback(this, event, closedCore));
        if (handled) return;
      }
      if (update?.message?.text) {
        const handled = await handleAuthMessage(this, event);
        if (handled) return;
      }
    } catch (err) {
      console.error(`${EXT_MARKER} handleUpdate error:`, err?.message || err);
    }
    return origHandleUpdate.call(this, update, webhookReplyEnvelope);
  };
}
