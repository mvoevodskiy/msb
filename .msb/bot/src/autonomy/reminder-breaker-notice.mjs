/**
 * Old d4 Telegram copy for [reminder breaker](./reminder-breaker.mjs) transitions.
 * [Dispatcher](./reminder-dispatch.mjs) sends this plain text to the saved chat
 * after the action and run journal have been updated.
 */
import { formatReminderClock } from './reminder-time.mjs';

const plural = new Intl.PluralRules('ru');
const unit = (count, words) => count + ' ' + words[plural.select(count)];

function pauseDuration(at, downSince) {
  const age = Date.parse(at) - Date.parse(downSince);
  if (!Number.isFinite(age) || age < 60_000) return 'меньше минуты';
  const minutes = Math.round(age / 60_000);
  if (minutes < 60) return unit(minutes, { one: 'минуту', few: 'минуты', many: 'минут' });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return unit(hours, { one: 'час', few: 'часа', many: 'часов' });
  return unit(Math.round(hours / 24), { one: 'день', few: 'дня', many: 'дней' });
}

export function reminderBreakerNotice(event, name, at) {
  const action = 'Автономное действие «' + name + '»';
  if (event.kind === 'recover') {
    return '✔ ' + action + ' снова работает. Пауза была ' + pauseDuration(at, event.downSince) + '.';
  }
  // Old Rz called d4 without a zone override. A spent once has no automatic retry.
  const until = formatReminderClock(Date.parse(event.backoffUntil), 'Europe/Moscow').replace(/^в /u, '');
  const reason = event.reason ? 'Причина: ' + event.reason + '.\n' : '';
  return '📡 ' + action + ' не выполнилось несколько раз подряд.\n' + reason + 'Поставил на паузу до ' + until + '.';
}
