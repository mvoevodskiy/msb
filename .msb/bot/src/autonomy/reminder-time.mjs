/**
 * Local date and time for [registration](./reminder-protocol.mjs) and
 * [task cards](../telegram/screens/reminders.mjs). Next cron slot uses the
 * same [owner clock](./reminder-schedule.mjs) as the local scheduler.
 */
import { nextReminderCronAt } from './reminder-schedule.mjs';

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

function localDateLabel(target, now, timezone) {
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
  return day + ' в ' + time.hour + ':' + time.minute + ' (' + label + ')';
}

export function describeReminderTime(at, now, timezone) {
  const target = Date.parse(at);
  const when = localDateLabel(target, now, timezone);
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

const recurringPlural = new Intl.PluralRules('ru');
function recurringUnit(count, forms) {
  return count + ' ' + forms[recurringPlural.select(count)];
}

/** Old schedule labels for saved reminders in the existing task card. */
export function describeReminderSchedule(trigger, now, timezone, { codeCron = false } = {}) {
  if (trigger.kind === 'once') return describeReminderTime(trigger.at, now, timezone);
  if (trigger.kind === 'interval') return 'каждые ' + trigger.intervalMinutes + ' мин';
  const zone = timezone || 'Europe/Moscow';
  const zoneLabel = Object.hasOwn(zoneNames, zone) ? zoneNames[zone] : zone;
  const suffix = ' (' + zoneLabel + ')';
  const [minute, hour, day, month, weekday] = trigger.cron.trim().split(/\s+/);
  if (day === '*' && month === '*' && weekday === '*') {
    const hourlyStep = /^\*\/(\d{1,2})$/.exec(hour);
    if (minute === '0' && hourlyStep && 24 % Number(hourlyStep[1]) === 0) {
      return 'каждые ' + recurringUnit(Number(hourlyStep[1]), { one: 'час', few: 'часа', many: 'часов' }) + suffix;
    }
    const minuteStep = /^\*\/(\d{1,2})$/.exec(minute);
    if (hour === '*' && minuteStep && 60 % Number(minuteStep[1]) === 0) {
      return 'каждые ' + recurringUnit(Number(minuteStep[1]), { one: 'минуту', few: 'минуты', many: 'минут' });
    }
  }
  if (day === '*' && month === '*' && /^\d{1,2}$/.test(minute)) {
    if (hour === '*' && weekday === '*') return Number(minute) === 0
      ? 'каждый час' + suffix : 'каждый час в ' + minute.padStart(2, '0') + ' минут' + suffix;
    if (/^\d{1,2}$/.test(hour)) {
      const dayNames = ['воскресеньям', 'понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам'];
      const period = weekday === '*' ? 'каждый день' : weekday === '1-5' ? 'по будням' :
        ['0,6', '6,0'].includes(weekday) ? 'по выходным' : /^[0-6]$/.test(weekday) ? 'по ' + dayNames[Number(weekday)] : '';
      if (period) return period + ' в ' + hour.padStart(2, '0') + ':' + minute.padStart(2, '0') + suffix;
    }
  }
  const literal = codeCron ? '`' + trigger.cron + '`' : trigger.cron;
  return 'по расписанию ' + literal + suffix;
}

export function describeRegisteredReminderSchedule(trigger, now, timezone = 'Europe/Moscow') {
  const label = describeReminderSchedule(trigger, now, timezone, { codeCron: true });
  if (trigger.kind !== 'cron') return label;
  const next = nextReminderCronAt(trigger.cron, now, timezone);
  return next === undefined ? label : label + ' · следующее ' + localDateLabel(next, now, timezone);
}
