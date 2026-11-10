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
    if ((process.env.MSB_CC_ONLY || process.env.JARVIS_CC_ONLY) === '1' && data !== 'eng:home') {
      return show({ text: CC_BLOCK(), keyboard: (await engineMenu(snap)).keyboard });
    }
    return show(await engineMenu(snap));
  }
  if (data === 'eng:status') {
    try {
      const { result, snapshot: snap } = await refreshEngineStatus({ signal });
      const note = result
        ? `\n\nЗаявка <code>${result.code}</code> (${result.result})`
        : '\n\n⚠️ Нет ответа helper за 20с';
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
      const result = await waitRequestResult(id, { timeoutMs: 60_000 });
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
