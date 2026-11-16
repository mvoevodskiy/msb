/**
 * Saved prompt output goes only to the owner chat selected by
 * [dispatcher](./reminder-dispatch.mjs). Quiet/digest bodies skip the publish
 * banner and may drop thinking via [trimOwnerDigestText](#trimOwnerDigestText).
 * HTML rendering: [response](../telegram/response.mjs).
 * Checks: [quiet-owner-trim](../../tests/quiet-owner-trim.test.mjs),
 * [response-delivery](../../tests/response-delivery.test.mjs).
 */
import { renderResponseHtml, splitHtml } from '../telegram/response.mjs';
import { singleRequestSignal } from '../telegram/presentation-api.mjs';

function digestFenceInner(text) {
  const fence = /```(html|HTML)?\n([\s\S]*?)```/.exec(text);
  if (!fence) return null;
  const inner = fence[2].trim();
  if (!inner) return null;
  const first = inner.split('\n').find((line) => line.trim()) || '';
  const htmlLang = Boolean(fence[1]);
  if (!(htmlLang || /^(?:<(?:b|i)\b|🟢|🔴)/.test(first))) return null;
  if (htmlLang && !/<(?:b|i|u|s|code|pre|blockquote|a|tg-spoiler)\b/i.test(inner)
    && !/^(?:🟢|🔴)/.test(first)) {
    return null;
  }
  const after = text.slice(fence.index + fence[0].length).trim();
  return (after ? `${inner}\n${after}` : inner).trimEnd();
}

/** Keep from the first owner-digest line or unwrap a Telegram-HTML fence body. */
export function trimOwnerDigestText(text) {
  const src = String(text ?? '');
  const fromFence = digestFenceInner(src);
  if (fromFence != null) return fromFence;
  const match = /^(?:🟢|🔴|[ \t]*<(?:b|i)\b)/im.exec(src);
  if (!match) return src.trimEnd();
  return src.slice(match.index).trimEnd();
}

function ownerDigestBody(text, quietOwner) {
  if (quietOwner) return true;
  return /^(?:🟢|🔴|<(?:b|i)\b)/i.test(String(text || '').trimStart());
}

export async function deliverSavedPrompt(api, chat, result, signal) {
  if (result.status !== 'ok' && result.status !== 'error') return result;
  const digestText = result.text ? trimOwnerDigestText(result.text) : '';
  const quietOwner = result.status === 'ok' && ownerDigestBody(digestText, result.quietOwner);
  const summary = result.timeout ? '⏱ Ход остановлен по сроку.'
    : result.status === 'error' ? '⚠️ Ход не удался — вот что движок успел вернуть.'
    : digestText ? '✅ Готово: 1 сообщение.\nНичего не опубликовано, посмотри и поправь. Ниже каждое отдельным сообщением.' : '✅ Готово.';
  try {
    const bodyParts = digestText ? splitHtml(renderResponseHtml(digestText), 3900) : [];
    const parts = digestText
      ? (quietOwner ? bodyParts : [summary, ...bodyParts])
      : [summary];
    for (const [index, part] of parts.entries()) {
      if (signal.aborted) {
        if (index === 0) return { status: 'stopped', detail: 'ход прерван остановкой фоновых задач',
          fileCommitStarted: result.fileCommitStarted };
        return { ...result, status: result.status === 'error' ? 'error' : 'skipped', outcome: 'stopped',
          detail: 'выдача прервана после отправки части результата' };
      }
      await api.sendMessage(chat, part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        singleRequestSignal(AbortSignal.timeout(15_000)));
    }
    return result.text && digestText !== result.text ? { ...result, text: digestText } : result;
  } catch {
    return { ...result, status: 'error', detail: undefined, error: 'не удалось отправить результат фоновой задачи' };
  }
}
