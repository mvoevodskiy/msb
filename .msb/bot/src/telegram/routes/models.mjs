/**
 * Old Claude model callbacks: one pre-ack lock alert, then the existing setter.
 * [Router](../router.mjs) owns ack timing/scope; [native version](../../agent/claude-version.mjs)
 * feeds [policy](../../agent/models.mjs) and [pure screens](../screens/models.mjs).
 * Never writes provider/native config; checks: [catalog](../../../tests/model-catalog.test.mjs).
 */
import { readClaudeVersion } from '../../agent/claude-version.mjs';
import { modelCallbackChoice } from '../../agent/models.mjs';
import { loadState } from '../../state.mjs';
import { applyModelFamily } from '../actions.mjs';
import { modelScreen, modelVersionsScreen } from '../screens/models.mjs';
import { agentScreen } from '../screens/agent.mjs';
import { UNHANDLED } from './shared.mjs';
export const isModelSelectionCallback = data => /^settings:model:(set|fable|fableok):/.test(data);
export async function handleModelRoute({ data, state, show, answer }) {
  const read = data === 'settings:model' || data === 'settings:model:ver';
  if (!read && !isModelSelectionCallback(data)) return UNHANDLED;
  if (state.engine === 'oc') return show(await agentScreen(state));
  const version = await readClaudeVersion();
  if (read) return show(data.endsWith(':ver') ? modelVersionsScreen(state,version) : modelScreen(state,version));
  const choice = modelCallbackChoice(data,version);
  if (choice?.locked) return answer({ show_alert: true, text: choice.model.label + ' откроется после обновления системы.' });
  if (choice && !await applyModelFamily(choice.model.key, () => readClaudeVersion())) {
    return answer({ show_alert: true, text: choice.model.label + ' откроется после обновления системы.' });
  }
  await answer();
  return show(await agentScreen((await loadState()).state));
}
