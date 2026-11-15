/**
 * Движки: опциональный OS helper и обычный экран.
 * Навигация: [Telegram](../README.md).
 */
import { handleNativeEngineCallback } from '../../engines/telegram.mjs';
import { wakeWithFallback } from '../../engines/wake.mjs';
import { botId } from '../../paths.mjs';
import { UNHANDLED } from './shared.mjs';

export async function handleEnginesRoute({ data, state, show, bot, engineMenu, signal }) {
  if (data === 'eng:wake') {
    const sleep = bot[Symbol.for('msb.engineSleep')];
    // Codex uses the existing local marker directly; do not publish a system
    // request or involve another engine if local wake fails.
    const ok = state.extAuthBypass === 'codex'
      ? await sleep?.wake()
      : await wakeWithFallback(sleep, { botId: botId(), signal });
    if (!ok) return show({ text: 'Не получилось переключить бота. Попробуй ещё раз.', keyboard: (await engineMenu()).keyboard });
    return show(await engineMenu());
  }
  if (process.env.MSB_OS_ENGINE === 'native' && await handleNativeEngineCallback({
    data, state, show, signal, providerView: () => bot[Symbol.for('msb.engineProviderView')]?.(state),
  })) return;
  if (data === 'eng:home' || data === 'eng:add' || data === 'eng:mig') {
    if (process.env.JARVIS_CC_ONLY === '1' && data !== 'eng:home') {
      return show({ text: CC_BLOCK(), keyboard: (await engineMenu()).keyboard });
    }
    return show(await engineMenu());
  }

  return UNHANDLED;
}

function CC_BLOCK() {
  return `Этот бот работает только с 👾 Claude Code.
Управление OpenClaw через это меню пока не подключено.`;
}
