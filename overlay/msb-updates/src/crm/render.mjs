// Страницы CRM: вход, список установок, карточка владельца.
// Вход: записи Установщика без токенов площадки. Выход: HTML.
// Переписка на этом шаге пустая. Проверка: tests/crm.test.mjs.

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: sans-serif; margin: 2rem auto; max-width: 42rem; line-height: 1.4; }
    form { display: grid; gap: 0.75rem; }
    input, button { font: inherit; }
    .err { color: #8a1f1f; }
    li { margin: 0.4rem 0; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderLogin({ error = '' } = {}) {
  const message = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return page('Вход', `${message}
<form method="post" action="/crm/login">
  <label>Пароль <input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">Войти</button>
</form>`);
}

function ownerLine(item) {
  const name = item.owner_name || 'без имени';
  const user = item.owner_username ? `@${item.owner_username}` : '';
  return [name, user, item.owner_tg_user_id].filter(Boolean).join(' ');
}

function ticketLine(ticket) {
  const who = ticket.tg_user_id || 'без id';
  const preview = ticket.preview ? ` — ${ticket.preview}` : '';
  return `${who}${preview}`;
}

export function renderList({ installations, csrf, tickets = null }) {
  const items = installations.length
    ? `<ul>${installations.map((item) => `<li><a href="/crm/installations/${escapeHtml(item.id)}">${escapeHtml(ownerLine(item))}</a> — ${escapeHtml(item.host || 'без адреса')} — ${escapeHtml(item.status)}</li>`).join('')}</ul>`
    : '<p>Установок пока нет.</p>';
  const queue = tickets == null
    ? ''
    : `<h2>Обращения</h2>${tickets.length
      ? `<ul>${tickets.map((ticket) => `<li><a href="/crm/tickets/${escapeHtml(ticket.id)}">${escapeHtml(ticketLine(ticket))}</a></li>`).join('')}</ul>`
      : '<p>Открытых обращений нет.</p>'}`;
  return page('Установки', `<h1>Установки</h1>
${items}
${queue}
<form method="post" action="/crm/logout">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button type="submit">Выйти</button>
</form>`);
}

export function renderCard({ installation, csrf }) {
  const rows = [
    ['Владелец', ownerLine(installation)],
    ['Установка', installation.id],
    ['Адрес', installation.host || 'без адреса'],
    ['Статус', installation.status],
    ['Откуда', installation.origin || ''],
    ['Площадка', installation.provider || ''],
  ];
  const table = rows.map(([label, value]) => `<p><b>${escapeHtml(label)}.</b> ${escapeHtml(value)}</p>`).join('');
  return page('Карточка', `<p><a href="/crm">К списку</a></p>
<h1>${escapeHtml(ownerLine(installation))}</h1>
${table}
<h2>Переписка</h2>
<p>Переписки пока нет.</p>
<form method="post" action="/crm/logout">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button type="submit">Выйти</button>
</form>`);
}

export function renderTicket({ ticket, csrf, operationId, error = '' }) {
  const messages = (ticket.messages || []).map((item) => {
    const who = item.direction === 'out' ? 'Оператор' : 'Человек';
    return `<p><b>${who}.</b> ${escapeHtml(item.body)}</p>`;
  }).join('') || '<p>Сообщений пока нет.</p>';
  const delivery = (ticket.outbox || []).map((item) => `<li>${escapeHtml(item.status)}: ${escapeHtml(item.payload?.text || '')}</li>`).join('');
  const queue = delivery ? `<h2>Очередь</h2><ul>${delivery}</ul>` : '';
  const message = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  const reply = ticket.status === 'open' ? `<form method="post" action="/crm/tickets/${escapeHtml(ticket.id)}/reply">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <input type="hidden" name="operation_id" value="${escapeHtml(operationId)}">
  <input type="hidden" name="expected_revision" value="${escapeHtml(ticket.case_revision)}">
  <label>Ответ <textarea name="text" maxlength="4000" required></textarea></label>
  <button type="submit">Отправить</button>
</form>
<form method="post" action="/crm/tickets/${escapeHtml(ticket.id)}/close">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button type="submit">Закрыть</button>
</form>` : '<p>Обращение закрыто.</p>';
  return page('Обращение', `<p><a href="/crm">К списку</a></p>
<h1>Обращение</h1>
<p>Статус: ${escapeHtml(ticket.status)}. Источник: ${escapeHtml(ticket.source)}.</p>
${messages}
${queue}
${message}
${reply}`);
}

export function publicCard(installation) {
  if (!installation) return null;
  return {
    id: installation.id,
    owner_tg_user_id: installation.owner_tg_user_id,
    owner_username: installation.owner_username,
    owner_name: installation.owner_name,
    origin: installation.origin,
    provider: installation.provider,
    host: installation.host,
    status: installation.status,
  };
}
