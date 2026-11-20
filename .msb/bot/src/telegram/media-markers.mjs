/**
 * Final model text → outbound Telegram media markers stripped to a send queue.
 * Old e8A/okA/skA: [ФОТО|ФАЙЛ|…: path caption]. Caller [bot](./bot.mjs) delivers
 * clean text first, then [sendMedia](./send-media.mjs).
 * Checks: [media-markers](../../tests/media-markers.test.mjs).
 */

const TYPES = {
  ФОТО: 'photo', PHOTO: 'photo',
  ФАЙЛ: 'document', FILE: 'document',
  СТИКЕР: 'sticker', STICKER: 'sticker',
  ВИДЕО: 'video', VIDEO: 'video',
  АУДИО: 'audio', AUDIO: 'audio',
  ГОЛОС: 'voice', VOICE: 'voice',
  GIF: 'animation', ANIMATION: 'animation',
};

const MARKER = /\[(ФОТО|ФАЙЛ|СТИКЕР|ВИДЕО|АУДИО|ГОЛОС|GIF|PHOTO|FILE|STICKER|VIDEO|AUDIO|VOICE|ANIMATION):\s*([^\]\s]+)(?:\s+([^\]]*))?\]/gi;

/** Extract media markers; returned text has markers removed (old e8A). */
export function extractMediaMarkers(text) {
  const items = [];
  const clean = String(text ?? '').replace(MARKER, (_all, kind, rawPath, caption) => {
    items.push({
      type: TYPES[String(kind).toUpperCase()] || 'document',
      path: String(rawPath).trim(),
      caption: caption?.trim()?.slice(0, 1024) || undefined,
    });
    return '';
  });
  return { text: clean.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd(), items };
}
