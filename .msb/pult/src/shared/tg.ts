// Минимальная отправка в Telegram для мест, где нет веб-сервиса с его журналом отправок:
// тревога systemd об отказе службы (src/cli/notify-failure.ts) и сторож сборщика (src/collector/watch.ts).
// Токен не попадает ни в возвращаемые ошибки, ни в журнал: URL с токеном наружу не отдаётся.

export interface TgTarget { token: string; chatId: string; apiBase?: string }

/** Настройки из окружения: PULT_TG_TOKEN + PULT_TG_CHAT_ID (или OWNER_USER_ID). Нет — null. */
export function tgFromEnv(env: NodeJS.ProcessEnv): TgTarget | null {
  const token = env.PULT_TG_TOKEN?.trim();
  const chatId = (env.PULT_TG_CHAT_ID || env.OWNER_USER_ID || '').trim();
  if (!token || !chatId) return null;
  return { token, chatId, apiBase: env.PULT_TG_API_BASE || undefined };
}

export function escHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Отправить HTML-сообщение; до 3 попыток. null — отправлено, иначе причина без токена. */
export async function sendTg(t: TgTarget, text: string, opts: { fetchFn?: typeof fetch; delaysMs?: number[] } = {}): Promise<string | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const delays = opts.delaysMs ?? [3000, 6000];
  const body = JSON.stringify({ chat_id: t.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  let last = 'неизвестная ошибка';
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const r = await fetchFn(`${t.apiBase ?? 'https://api.telegram.org'}/bot${t.token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return null;
      const desc = ((await r.json().catch(() => ({}))) as { description?: string }).description ?? '';
      last = `Telegram ответил ${r.status}${desc ? `: ${desc.split(t.token).join('***')}` : ''}`;
      if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) return last;
    } catch (e) {
      // В тексте ошибки fetch может быть URL с токеном — берём только имя ошибки.
      last = `нет связи с Telegram (${(e as Error).name})`;
    }
    if (attempt < delays.length) await new Promise(res => setTimeout(res, delays[attempt]));
  }
  return last;
}
