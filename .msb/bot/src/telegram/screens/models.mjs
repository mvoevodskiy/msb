/**
 * Pure old family/version screens. [Route](../routes/models.mjs) supplies verified
 * native CLI metadata, [policy](../../agent/models.mjs) owns locks/aliases.
 * No setting/CLI writes. Checks: [catalog](../../../tests/model-catalog.test.mjs).
 */
import { resolveModel } from '../../state.mjs';
import { InlineKeyboard } from 'grammy';
import { MODEL_FAMILIES, familyChoice, modelOptions, getClaudeModel, isFamilyAlias, modelShortLabel } from '../../agent/models.mjs';
import { escapeHtml } from '../edit.mjs';
const lockNote = '<i>🔒 откроется после обновления системы.</i>';
function rows(buttons) {
  const kb = new InlineKeyboard();
  buttons.forEach((b,index) => { if (index && index % 2 === 0) kb.row(); kb.text(b.text,b.data); });
  return kb;
}
export function modelScreen(state = {}, version) {
  const value = resolveModel(state), current = getClaudeModel(value);
  const families = MODEL_FAMILIES.map(f => ({ ...f, choice: familyChoice(f.id, version) })).filter(f => f.choice);
  const alias = Boolean(current && isFamilyAlias(current));
  const buttons = families.map(f => ({
    text: f.button + (alias && f.choice.model.cliModel === current.cliModel ? ' ✓' : f.choice.locked ? ' 🔒' : ''),
    data: 'settings:model:set:' + f.choice.model.key,
  }));
  buttons.push({ text: '📌 Версии' + (current?.kind === 'pinned' ? ' ✓' : ''), data: 'settings:model:ver' }, { text: '« Назад', data: 'menu:agent' });
  const suffix = alias ? '. Сама переходит на новейшую.' : current?.kind === 'pinned' ? ', фиксированная версия.' : '.';
  return { text: `<b>🧠 Модель</b>\n\nСейчас: <b>${escapeHtml(modelShortLabel(value,version))}</b>${suffix}\n\n${families.map(f => `<b>${f.button}</b>: ${f.line}`).join('\n')}${families.some(f => f.choice.locked) ? '\n\n' + lockNote : ''}\n\n<i>Смена модели сохраняет беседу.</i>`, keyboard: rows(buttons) };
}
export function modelVersionsScreen(state = {}, version) {
  const current = getClaudeModel(resolveModel(state));
  const order = family => MODEL_FAMILIES.findIndex(f => f.id === family);
  const options = modelOptions(version).filter(o => o.model.kind === 'pinned').sort((a,b) => order(a.model.family) - order(b.model.family));
  const kb = rows(options.map(({model,locked}) => ({ text: model.button + (current?.cliModel === model.cliModel ? ' ✓' : locked ? ' 🔒' : ''), data: 'settings:model:set:' + model.key })));
  kb.row().text('« Назад','settings:model');
  return { text: '<b>📌 Версии</b>\n\nФиксированная версия не обновляется сама. Бери её, если проверил на своих задачах.' + (options.some(o => o.locked) ? '\n\n' + lockNote : ''), keyboard: kb };
}
