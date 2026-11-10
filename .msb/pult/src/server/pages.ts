// Страницы входа и подключения второго фактора — формы без обязательного JS.
// tg-bridge.js на входе: в Mini App тихо входит по подписи Telegram; в браузере не мешает.
// Классы разметки договорены с исполнителем интерфейса (стили — /ui/auth.css), не переименовывать.

import qrcode from 'qrcode-generator';
import { groupSecret, otpauthUri } from './totp.ts';

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex, nofollow"><meta name="color-scheme" content="dark"><title>${escHtml(title)}</title><link rel="stylesheet" href="/ui/auth.css"><script src="/ui/tg-bridge.js" defer></script></head>
<body class="auth-page"><main class="auth">${body}</main></body></html>
`;
}

const errorBlock = (error: string | null): string => (error ? `<p class="auth-error" role="alert">${escHtml(error)}</p>` : '');

export interface LoginPageOptions {
  /** Второй фактор уже подключён — нужно поле кода. */
  enrolled: boolean;
  error: string | null;
}

export function loginPage(o: LoginPageOptions): string {
  const sub = o.enrolled
    ? 'Вход для владельца: пароль и код из приложения-аутентификатора.'
    : 'Первый вход: после пароля подключишь второй фактор — приложение-аутентификатор на телефоне.';
  const code = o.enrolled
    ? '<label class="auth-label">Код из приложения<input class="auth-input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>\n'
    : '';
  return page('Пульт — вход', `<h1 class="auth-title">Пульт</h1><p class="auth-sub">${escHtml(sub)}</p>
<p class="auth-hint" id="tg-auth-status" aria-live="polite"></p>
<form class="auth-form" method="post" action="/login"><label class="auth-label">Пароль<input class="auth-input" type="password" name="password" autocomplete="current-password" required autofocus></label>
${code}${errorBlock(o.error)}<button class="auth-button" type="submit">Войти</button></form>`);
}

export function qrSvg(text: string): string {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }).replace('<svg ', '<svg role="img" aria-label="QR-код для приложения-аутентификатора" ');
}

export function enrollPage(secret: string, error: string | null): string {
  return page('Пульт — второй фактор', `<h1 class="auth-title">Пульт</h1><p class="auth-sub">Подключи второй фактор: отсканируй QR-код в приложении-аутентификаторе на телефоне и введи 6 цифр, которые оно покажет. Подключается один раз.</p>
<div class="auth-qr">${qrSvg(otpauthUri(secret))}</div>
<p class="auth-hint">Не сканируется — добавь ключ вручную (тип «по времени», 6 цифр, 30 секунд):</p>
<code class="auth-secret">${escHtml(groupSecret(secret))}</code>
<form class="auth-form" method="post" action="/enroll"><label class="auth-label">Код из приложения<input class="auth-input" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus></label>
${errorBlock(error)}<button class="auth-button" type="submit">Подключить</button></form>`);
}

/** Простая страница-сообщение (нет интерфейса, 404 и т. п.) — в том же оформлении. */
export function messagePage(title: string, text: string): string {
  return page(`Пульт — ${title}`, `<h1 class="auth-title">Пульт</h1><p class="auth-sub">${escHtml(text)}</p><p class="auth-hint"><a href="/">На главную</a></p>`);
}
