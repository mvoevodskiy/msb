/**
 * Telegram getFile → bytes. Caller owns workspace writes and agent prompts.
 * Used by [attachments](../telegram/attachments.mjs) and [voice](../telegram/voice.mjs).
 */
import { audioTimeoutMs } from './stt.mjs';

export async function downloadTelegramFile(api, botToken, fileId, { signal, sizeHint } = {}) {
  signal?.throwIfAborted?.();
  let file;
  try {
    file = await api.getFile(fileId, signal);
  } catch {
    signal?.throwIfAborted?.();
    throw Error('Не удалось получить файл из Telegram');
  }
  signal?.throwIfAborted?.();
  if (!file?.file_path) throw Error('Не удалось скачать файл: нет пути');
  const timeout = audioTimeoutMs(sizeHint ?? file.file_size);
  try {
    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw Error(`Не удалось скачать файл: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    signal?.throwIfAborted?.();
    return { bytes, filePath: file.file_path, fileSize: file.file_size ?? bytes.length };
  } catch (err) {
    signal?.throwIfAborted?.();
    if (err.name === 'TimeoutError') throw Error(`Телеграм не ответил за ${Math.round(timeout / 1000)} с`);
    if (/^Не удалось скачать файл:/.test(err.message)) throw err;
    throw Error('Не удалось скачать файл');
  }
}
