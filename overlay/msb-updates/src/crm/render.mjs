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

export function renderList({ installations, csrf }) {
  const items = installations.length
    ? `<ul>${installations.map((item) => `<li><a href="/crm/installations/${escapeHtml(item.id)}">${escapeHtml(ownerLine(item))}</a> — ${escapeHtml(item.host || 'без адреса')} — ${escapeHtml(item.status)}</li>`).join('')}</ul>`
    : '<p>Установок пока нет.</p>';
  return page('Установки', `<h1>Установки</h1>
${items}
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
