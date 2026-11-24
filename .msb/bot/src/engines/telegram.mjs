/** Native OS-helper callbacks. JAR1 keeps these disabled in its runtime profile. */
import { engineStatusSnapshot, submitRequest, waitRequestResult, refreshEngineStatus } from './client.mjs';
import { nativeEnginesScreen } from './screen.mjs';
const ACTIONS = new Set(['eng:home', 'eng:add', 'eng:mig', 'eng:status', 'eng:oc:on', 'eng:oc:off']);
export async function handleNativeEngineCallback({ data, state, show, providerView, signal }) {
  if (!ACTIONS.has(data)) return false;
  const engineMenu = async snapshot => nativeEnginesScreen(state, snapshot, await providerView?.());
  await (async () => {
  if (data === 'eng:home' || data === 'eng:add' || data === 'eng:mig') {
    const snap = await engineStatusSnapshot();
    if ((process.env.MSB_CC_ONLY === '1' || process.env.JARVIS_CC_ONLY === '1') && data !== 'eng:home') {
      const text = process.env.JARVIS_CC_ONLY === '1'
        ? CC_BLOCK() : 'Управление OpenClaw через это меню отключено настройкой бота.';
      return show({ text, keyboard: (await engineMenu(snap)).keyboard });
    }
    return show(await engineMenu(snap));
  }
  if (data === 'eng:status') {
    try {
      const { result, snapshot: snap, serviceUnavailable } = await refreshEngineStatus({ signal });
      let note = '\n\n⚠️ Системная служба не ответила за 20с';
      if (serviceUnavailable) note = '\n\n⚠️ Системная служба не запущена.';
      if (result) note = `\n\nЗаявка <code>${result.code}</code> (${result.result})`;
      const screen = await engineMenu(snap);
      return show({ text: screen.text + note, keyboard: screen.keyboard });
    } catch (err) {
      return show({
        text: `Не удалось связаться с msb-engine: ${err.message}`,
        keyboard: (await engineMenu()).keyboard,
      });
    }
  }
  if (data === 'eng:oc:on' || data === 'eng:oc:off') {
    const action = data === 'eng:oc:on' ? 'enable-openclaw' : 'disable-openclaw';
    try {
      const { id } = await submitRequest(action, {
        bot_id: process.env.MSB_BOT_ID || 'default',
      });
      // The service has up to ten minutes for drain, state publication and wake.
      const result = await waitRequestResult(id, { timeoutMs: 630_000 });
      const snap = await engineStatusSnapshot();
      const screen = await engineMenu(snap);
      const note = result
        ? `\n\n${action}: <code>${result.code}</code>`
        : `\n\n⚠️ ${action}: нет ответа`;
      return show({ text: screen.text + note, keyboard: screen.keyboard });
    } catch (err) {
      return show({
        text: `${action} ошибка: ${err.message}`,
        keyboard: (await engineMenu()).keyboard,
      });
    }
  }

  })();
  return true;
}

function CC_BLOCK() {
  return `Этот бот работает только с 👾 Claude Code.
OpenClaw ставится отдельно: /settings → ⚙️ Движки → ➕ OpenClaw.`;
}
