/**
 * Parent of the shared connection menu in core and overlay. The current
 * Telegram keyboard carries the navigation context across redraws.
 * [Menu checks](../tests/menu-handlers.test.mjs).
 */
const AGENT = Object.freeze({ entry: 'settings:conn', back: 'menu:agent' });
const SETTINGS = Object.freeze({ entry: 'settings:auth', back: 'menu:settings' });

// Direct entry or the known Back button of a connection screen or its nested form.
export function connectionNavigation(data, message) {
  if (data === AGENT.entry) return AGENT;
  if (data === SETTINGS.entry || data === 'ext:conn') return SETTINGS;
  const rows = message?.reply_markup?.inline_keyboard;
  const footer = Array.isArray(rows) ? rows.at(-1) : undefined;
  const button = Array.isArray(footer) && footer.length === 1 ? footer[0] : undefined;
  if (button?.text !== '« Назад') return;
  const callback = button.callback_data;
  if (callback === AGENT.entry || callback === AGENT.back) return AGENT;
  if (callback === SETTINGS.entry || callback === SETTINGS.back || callback === 'settings:back') return SETTINGS;
}
