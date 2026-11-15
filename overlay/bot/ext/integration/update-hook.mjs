/**
 * Owner boundary, отмена форм и передача события core.
 * Admission failure/cross-chat checks: [input boundary](../tests/input-boundary.test.mjs).
 * Native skills metadata → [Codex reader](../codex-skills.mjs), core read routes remain shared.
 * Native MCP metadata → [Codex user catalog](../codex-mcp.mjs).
 * Saved Codex admission and execution → [adapter](../adapters/saved-codex.mjs).
 * Saved Cursor admission and execution → [adapter](../adapters/saved-cursor.mjs).
 * Engine sleep admission stays in the core [gate](../../../../.msb/bot/src/engines/sleep.mjs).
 * A Claude selection captures [Codex pause intent](../codex-pause-switch.mjs)
 * before asynchronous callback work; other callbacks retain their old gate.
 * Навигация: [Обвязка](../README.md).
 */
import { beginCallbackRender, runCallbackScope } from '../../shared/callback-renders.mjs';
import { registerEngineProviderView } from '../engine-menu.mjs';
import { registerCompactProvider } from '../compact-codex.mjs';
import {registerSkillsProvider} from '../codex-skills.mjs';
import {registerMcpProvider} from '../codex-mcp.mjs';
import { runSavedCodexPrompt, savedCodexPromptReady } from '../adapters/saved-codex.mjs';
import { createSavedCodexQuotaReader } from '../adapters/saved-codex-quota.mjs';
import { runSavedCursorPrompt, savedCursorPromptReady } from '../adapters/saved-cursor.mjs';
import { clearPendingAuth, getPendingAuth } from '../auth.mjs';
import { clearPendingLocalIp, getPendingLocalIp } from '../local-ssh.mjs';
import { runLocalExtCallback } from '../local-ext.mjs';
import { handleCallback } from './callbacks.mjs';
import { handleAuthMessage } from './text-input.mjs';
import { captureCodexPause } from '../codex-pause-switch.mjs';
import { EXT_MARKER } from './shared.mjs';

export function installUpdateHook(BotClass, env = process.env) {
  registerEngineProviderView(BotClass, env);
  registerCompactProvider(BotClass, env);
  registerSkillsProvider(BotClass, env);
  registerMcpProvider(BotClass, env);
  BotClass.prototype[Symbol.for('msb.savedCodexPrompt')] = runSavedCodexPrompt;
  BotClass.prototype[Symbol.for('msb.savedCodexPromptReady')] = savedCodexPromptReady;
  BotClass.prototype[Symbol.for('msb.createSavedCodexQuotaReader')] = createSavedCodexQuotaReader;
  BotClass.prototype[Symbol.for('msb.savedCursorPrompt')] = runSavedCursorPrompt;
  BotClass.prototype[Symbol.for('msb.savedCursorPromptReady')] = savedCursorPromptReady;
  const ownerId = Number(env.ADMIN_ID || env.OWNER_USER_ID || '0');
  const closedCore = env.MSB_USE_CLOSED_CORE === '1';
  const origHandleUpdate = BotClass.prototype.handleUpdate;
  BotClass.prototype.handleUpdate = async function handleUpdateExt(update, webhookReplyEnvelope) {
    const event = update?.callback_query || update?.message;
    if (!Number.isFinite(ownerId) || ownerId <= 0 || Number(event?.from?.id) !== ownerId) {
      return origHandleUpdate.call(this, update, webhookReplyEnvelope);
    }
    const selectingClaude = !closedCore && update?.callback_query &&
      ['settings:engine:set:cc', 'settings:conn:set:cc', 'ext:conn:set:claude'].includes(event.data);
    let pauseCapture;
    if (selectingClaude) {
      try { pauseCapture = { captured: true, intent: await captureCodexPause(this) }; }
      catch { pauseCapture = { captured: true, error: true }; }
    }
    try {
      const sleep = this[Symbol.for('msb.engineSleep')];
      if (sleep && await sleep.sleeping()) {
        const data = update?.callback_query?.data;
        const text = update?.message?.text || '';
        const chatId = event?.chat?.id;
        const inputOpen = chatId != null && !text.trim().startsWith('/') && Boolean(text.trim()) &&
          (getPendingAuth(event.from.id, { chatId, includeExpired: true }) ||
           getPendingLocalIp(event.from.id, { chatId, includeExpired: true }));
        const settings = /^\/settings(?:@\w+)?(?:\s|$)/.test(text);
        const selectClaude = data === 'ext:conn:set:claude' &&
          (Boolean(pauseCapture?.intent) || await sleep.allowStop?.());
        const allowedCallback = typeof data === 'string' && (data.startsWith('eng:') || data.startsWith('settings:') || selectClaude);
        if (!inputOpen && !settings && !allowedCallback) return origHandleUpdate.call(this, update, webhookReplyEnvelope);
      }
      if (update?.callback_query) {
        const render = beginCallbackRender(this, event);
        const startsForm = [
          'settings:auth:switch-sub', 'setup:subscription', 'settings:env:add',
          'settings:tz', 'menu:newproject', 'mon:add-hint', 'settings:bots:add', 'ext:ssh:local:edit',
          'settings:pult:password', 'settings:pult:tg-token', 'settings:pult:url',
          'settings:pult:session', 'settings:pult:listen:custom',
        ].includes(event.data) || /^(?:settings:env:quick:|mcp:setup:|ext:auth:|ext:conn:set:|settings:conn:set:|settings:engine:set:)/.test(event.data || '');
        // Core owns the scoped service draft. Clear only competing overlay forms on key selection.
        const serviceForm = !closedCore && /^svc_setup:[A-Z0-9_]+$/.test(event.data || '');
        if (startsForm || serviceForm || ['menu:back', 'menu:close', 'menu:settings', 'menu:agent', 'settings:back', 'settings:env', 'settings:env:cancel', 'settings:auth', 'settings:conn', 'ext:conn', 'ext:ssh:local', 'mon:back', 'settings:bots:cancel'].includes(event.data)) {
          const chatId = event.message?.chat?.id;
          if (chatId != null) {
            clearPendingAuth(event.from.id, { chatId });
            clearPendingLocalIp(event.from.id, { chatId });
            if (!serviceForm) this[Symbol.for('msb.cancelPendingInput')]?.(chatId);
          }
        }
        const handled = await runCallbackScope(render, () => handleCallback(this, event, closedCore, pauseCapture));
        if (handled) return;
        // После штатной обвязки: локальные пакеты владельца (новые callback_data).
        const localHandled = await runCallbackScope(render, () => runLocalExtCallback({
          bot: this,
          cq: event,
          closedCore,
          data: String(event.data || ''),
        }));
        if (localHandled) return;
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
