/**
 * Local date and time for the old once/reminder confirmation and task cards.
 * Called by [protocol](./reminder-protocol.mjs) and [views](../telegram/screens/autonomy.mjs).
 */
const zoneNames = {
  'Europe/Moscow': 'МСК', 'Europe/Kiev': 'Киев', 'Europe/Kyiv': 'Киев',
  'Europe/Minsk': 'Минск', 'Asia/Yekaterinburg': 'ЕКБ', 'Asia/Novosibirsk': 'НСК',
  'Asia/Krasnoyarsk': 'Красноярск', 'Asia/Irkutsk': 'Иркутск', 'Asia/Vladivostok': 'Владивосток',
  'Asia/Almaty': 'Алматы', 'Asia/Bishkek': 'Бишкек', 'Asia/Tashkent': 'Ташкент',
  'Asia/Dushanbe': 'Душанбе', 'Asia/Ashgabat': 'Ашхабад', 'Europe/Samara': 'Самара',
  'Europe/Kaliningrad': 'Калининград', 'Asia/Omsk': 'Омск', 'Asia/Yakutsk': 'Якутск',
  'Asia/Magadan': 'Магадан', 'Asia/Kamchatka': 'Камчатка', 'Europe/Chisinau': 'Кишинёв',
  'Asia/Nicosia': 'Кипр', 'Asia/Jerusalem': 'Иерусалим', 'Asia/Tel_Aviv': 'Иерусалим',
  'Europe/Belgrade': 'Белград', 'Europe/Lisbon': 'Лиссабон', 'Europe/Madrid': 'Мадрид',
  'Europe/Warsaw': 'Варшава', 'Europe/Riga': 'Рига', 'Europe/Vilnius': 'Вильнюс',
  'Europe/Tallinn': 'Таллин', 'Asia/Tokyo': 'Токио', 'Asia/Seoul': 'Сеул',
  'Asia/Shanghai': 'Шанхай', 'Asia/Hong_Kong': 'Гонконг', 'Asia/Singapore': 'Сингапур',
  'Asia/Kolkata': 'Дели', 'Asia/Colombo': 'Коломбо', 'Asia/Kathmandu': 'Катманду',
  'Asia/Karachi': 'Карачи', 'Asia/Tehran': 'Тегеран', 'Africa/Cairo': 'Каир',
  'America/Argentina/Buenos_Aires': 'Буэнос-Айрес', 'America/Sao_Paulo': 'Сан-Паулу',
  'America/Mexico_City': 'Мехико', 'America/Chicago': 'Чикаго', 'America/Denver': 'Денвер',
  'Australia/Sydney': 'Сидней', 'Asia/Tbilisi': 'Тбилиси', 'Asia/Yerevan': 'Ереван',
  'Asia/Baku': 'Баку', 'Europe/Istanbul': 'Стамбул', 'Asia/Bangkok': 'Бангкок',
  'Asia/Dubai': 'Дубай', 'America/New_York': 'Нью-Йорк', 'America/Los_Angeles': 'Лос-Анджелес',
  'Europe/London': 'Лондон', 'Europe/Berlin': 'Берлин', UTC: 'UTC',
};
const dayMs = 86_400_000;

function localTime(timeZone) {
  const format = new Intl.DateTimeFormat('ru-RU', {
    timeZone, year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
  });
  return time => Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]));
}

function sameDate(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function describeReminderTime(at, now, timezone) {
  const target = Date.parse(at);
  let zone = timezone || 'Europe/Moscow';
  let parts;
  try {
    parts = localTime(zone);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    zone = 'Europe/Moscow';
    parts = localTime(zone);
  }
  const time = parts(target);
  const day = sameDate(time, parts(now)) ? 'сегодня' :
    sameDate(time, parts(now + dayMs)) ? 'завтра' : time.day + ' ' + time.month;
  const label = Object.hasOwn(zoneNames, zone) ? zoneNames[zone] : time.timeZoneName.replace('GMT', 'UTC');
  const when = day + ' в ' + time.hour + ':' + time.minute + ' (' + label + ')';
  if (target <= now) return 'срок уже наступил (' + when + ')';
  const minutes = Math.round((target - now) / 60_000);
  if (minutes < 1 || minutes >= 60) return when;
  const unit = new Intl.PluralRules('ru').select(minutes);
  const word = { one: 'минуту', few: 'минуты', many: 'минут' }[unit];
  return when + ', через ' + minutes + ' ' + word;
}

/** Short old local clock for a subscription window reset. */
export function formatReminderClock(millis, timezone) {
  if (timezone) {
    try {
      const clock = localTime(timezone)(millis);
      const label = Object.hasOwn(zoneNames, timezone) ? zoneNames[timezone] : clock.timeZoneName.replace('GMT', 'UTC');
      return 'в ' + clock.hour + ':' + clock.minute + ' (' + label + ')';
    } catch { /* Old reset copy falls back to UTC for a missing or invalid zone. */ }
  }
  return new Date(millis).toISOString().slice(11, 16) + ' UTC';
}
