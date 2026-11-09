/** Saved prompt output goes only to the owner chat selected by [dispatcher](./reminder-dispatch.mjs). */
import { renderResponseHtml, splitHtml } from '../telegram/response.mjs';
import { singleRequestSignal } from '../telegram/presentation-api.mjs';

export async function deliverSavedPrompt(api, chat, result, signal) {
  if (result.status !== 'ok' && result.status !== 'error') return result;
  const summary = result.timeout ? '⏱ Ход остановлен по сроку.'
    : result.status === 'error' ? '⚠️ Ход не удался — вот что движок успел вернуть.'
    : result.text ? '✅ Готово: 1 сообщение.\nНичего не опубликовано, посмотри и поправь. Ниже каждое отдельным сообщением.' : '✅ Готово.';
  try {
    const parts = result.text ? [summary, ...splitHtml(renderResponseHtml(result.text), 3900)] : [summary];
    for (const [index, part] of parts.entries()) {
      if (signal.aborted) {
        if (index === 0) return { status: 'stopped', detail: 'ход прерван остановкой фоновых задач' };
        return { ...result, status: result.status === 'error' ? 'error' : 'skipped', outcome: 'stopped',
          detail: 'выдача прервана после отправки части результата' };
      }
      await api.sendMessage(chat, part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        singleRequestSignal(AbortSignal.timeout(15_000)));
    }
    return result;
  } catch {
    return { ...result, status: 'error', detail: undefined, error: 'не удалось отправить результат фоновой задачи' };
  }
}
