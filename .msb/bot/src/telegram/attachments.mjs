/**
 * Inbound Telegram media → workspace `.media/` + text prompt for the agent turn.
 * Old photo/video/document/audio/sticker/animation handlers; multimodal arrays
 * are flattened to disk paths the same way agent-cc a$A did before CLI launch.
 * Caller [bot](./bot.mjs) → [inbox](./inbox.mjs) → executeTurn → prepareAttachment.
 * [Forwarded batches](./batch.mjs) share the document download and type rules.
 * Download → [telegram-download](../media/telegram-download.mjs); STT → [stt](../media/stt.mjs).
 * Checks: [attachments](../../tests/attachments.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadTelegramFile } from '../media/telegram-download.mjs';
import { resolveSttConfig, transcribeVoice } from '../media/stt.mjs';
import { workspaceDir } from '../paths.mjs';
import { buildReplyContext } from './reply-context.mjs';

const exec = promisify(execFile);
const ALBUM_QUIET_MS = 2500;
const MAX_BYTES = 20 * 1024 * 1024;
const TEXT_INLINE_MAX = 20_480;
const TEXT_EXT = new Set(['.txt', '.md', '.json', '.csv', '.ts', '.js', '.py', '.yaml', '.yml', '.sh', '.log', '.toml', '.xml', '.html', '.css', '.sql', '.env.example']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function mediaDir(env = process.env) {
  return path.join(workspaceDir(env), '.media');
}

function safeName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'file';
}

async function saveBytes(bytes, name, env = process.env) {
  const dir = mediaDir(env);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}_${safeName(name)}`);
  await fs.writeFile(file, bytes);
  return file;
}

function withReply(ctx, prompt, referent = buildReplyContext(ctx.message, ctx.me?.id)) {
  return referent ? `${referent}\n\n${prompt}` : prompt;
}

function sizeLabel(bytes) {
  return bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`;
}

async function downloadToWorkspace(api, botToken, fileId, name, { signal, sizeHint, env } = {}) {
  const { bytes } = await downloadTelegramFile(api, botToken, fileId, { signal, sizeHint });
  return saveBytes(bytes, name, env);
}

async function saveImage(api, botToken, fileId, name, { signal, sizeHint, env } = {}) {
  const file = await downloadToWorkspace(api, botToken, fileId, name, { signal, sizeHint, env });
  return file;
}

async function tryTranscript(bytes, { signal, contentType = 'audio/ogg' } = {}) {
  try {
    await resolveSttConfig();
  } catch (err) {
    if (err?.code === 'STT_NOT_CONFIGURED') return null;
    throw err;
  }
  try {
    return await transcribeVoice(bytes, { signal, contentType });
  } catch {
    return null;
  }
}

async function extractVideoInsights(bytes, durationSec, { signal, isNote = false } = {}) {
  const frames = [];
  let transcript = null;
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-video-'));
    const video = path.join(directory, 'input.mp4');
    await fs.writeFile(video, bytes);
    signal?.throwIfAborted?.();
    try {
      const audio = path.join(directory, 'audio.ogg');
      await exec('ffmpeg', ['-i', video, '-vn', '-acodec', 'libopus', '-ar', '16000', '-ac', '1', '-y', audio], { timeout: 120_000, signal });
      const ogg = await fs.readFile(audio);
      transcript = await tryTranscript(ogg, { signal });
    } catch {
      signal?.throwIfAborted();
      /* optional track */
    }
    const duration = Math.max(1, Number(durationSec) || 3);
    const count = isNote ? 2 : Math.min(5, Math.max(3, Math.floor(duration / 15)));
    const step = Math.max(1, Math.floor(duration / (count + 1)));
    for (let i = 1; i <= count; i++) {
      const at = step * i;
      if (at >= duration) break;
      signal?.throwIfAborted?.();
      const frame = path.join(directory, `frame_${i}.jpg`);
      try {
        await exec('ffmpeg', ['-ss', String(at), '-i', video, '-vframes', '1', '-q:v', '3', '-y', frame], { timeout: 30_000, signal });
        const jpeg = await fs.readFile(frame);
        frames.push(await saveBytes(jpeg, `frame_${i}.jpg`));
      } catch {
        signal?.throwIfAborted();
        /* skip frame */
      }
    }
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  return { transcript, frames };
}

function photoPrompt(paths, caption, { includeTask = true } = {}) {
  const list = paths.map((file, i) => `Фото ${i + 1}: ${file}`).join('\n');
  const head = paths.length === 1
    ? 'Пользователь отправил фото. Файл уже сохранён — открой через Read:'
    : `Пользователь отправил ${paths.length} фото. Файлы уже сохранены — открой через Read:`;
  if (!includeTask) return `${head}\n${list}`;
  const task = caption || (paths.length > 1 ? `Галерея из ${paths.length} изображений. Проанализируй.` : 'Что на этом изображении?');
  return `${head}\n${list}\n\n${task}`;
}

async function preparePhoto(entry, botToken, signal) {
  const message = entry.ctx.message;
  const photos = message.photo || [];
  const best = photos[photos.length - 1];
  if (!best) throw Error('Нет фото в сообщении');
  const file = await saveImage(entry.ctx.api, botToken, best.file_id, 'photo.jpg', {
    signal, sizeHint: best.file_size, env: entry.env,
  });
  return withReply(entry.ctx, photoPrompt([file], message.caption));
}

async function prepareVideo(entry, botToken, signal) {
  const message = entry.ctx.message;
  const video = message.video || message.video_note;
  if (!video) throw Error('Нет видео в сообщении');
  const isNote = Boolean(message.video_note);
  const size = video.file_size || 0;
  if (size > MAX_BYTES) throw Error('Видео слишком большое (>20MB). Попробуй сжать или отправить ссылку.');
  const { bytes } = await downloadTelegramFile(entry.ctx.api, botToken, video.file_id, { signal, sizeHint: size });
  const saved = await saveBytes(bytes, isNote ? 'video_note.mp4' : 'video.mp4', entry.env);
  const insights = await extractVideoInsights(bytes, video.duration || 0, { signal, isNote });
  const notes = [];
  if (insights.transcript) notes.push(`Транскрипт (${video.duration || 0}с): ${insights.transcript}`);
  if (insights.frames.length) {
    notes.push(`Ключевые кадры:\n${insights.frames.map((f, i) => `Кадр ${i + 1}: ${f}`).join('\n')}`);
  }
  const caption = message.caption || (isNote ? 'Проанализируй это видео-сообщение (кружок).' : 'Проанализируй это видео.');
  const body = [
    `Пользователь отправил ${isNote ? 'видео-кружок' : 'видео'}. Файл сохранён: ${saved}`,
    notes.join('\n'),
    caption,
  ].filter(Boolean).join('\n\n');
  if (!insights.transcript && !insights.frames.length) {
    return withReply(entry.ctx, `${body}\n\nКадры/транскрипт недоступны (нужны ffmpeg и при желании STT). Открой файл сам.`);
  }
  return withReply(entry.ctx, body);
}

async function prepareAnimation(entry, botToken, signal) {
  const anim = entry.ctx.message.animation;
  if (!anim) throw Error('Нет GIF в сообщении');
  const { bytes } = await downloadTelegramFile(entry.ctx.api, botToken, anim.file_id, {
    signal, sizeHint: anim.file_size,
  });
  const saved = await saveBytes(bytes, anim.file_name || 'animation.gif', entry.env);
  const insights = await extractVideoInsights(bytes, anim.duration || 3, { signal });
  const caption = entry.ctx.message.caption || 'Что на этой гифке?';
  if (!insights.frames.length) {
    return withReply(entry.ctx, `Пользователь отправил GIF. Файл: ${saved}\n\n${caption}`);
  }
  return withReply(entry.ctx, [
    `Пользователь отправил GIF. Файл: ${saved}`,
    `Ключевые кадры:\n${insights.frames.map((f, i) => `Кадр ${i + 1}: ${f}`).join('\n')}`,
    caption,
  ].join('\n\n'));
}

function documentInfo(doc) {
  const name = doc.file_name || 'document';
  const size = doc.file_size || 0;
  const mime = doc.mime_type || '';
  const ext = path.extname(name).toLowerCase();
  return {
    name, size,
    image: mime.startsWith('image/') || IMAGE_EXT.has(ext),
    textual: mime.startsWith('text/') || TEXT_EXT.has(ext) || name.toLowerCase().endsWith('.env.example'),
  };
}

function saveDocument(entry, botToken, signal, { name, size }) {
  return downloadToWorkspace(entry.ctx.api, botToken, entry.ctx.message.document.file_id, name, {
    signal, sizeHint: size, env: entry.env,
  });
}

async function prepareDocument(entry, botToken, signal) {
  const doc = entry.ctx.message.document;
  if (!doc) throw Error('Нет документа в сообщении');
  const info = documentInfo(doc);
  const { name, size, image, textual } = info;
  if (size > MAX_BYTES) throw Error(`Файл ${name} слишком большой (${sizeLabel(size)}). Максимум 20MB.`);
  const saved = await saveDocument(entry, botToken, signal, info);
  if (image) return withReply(entry.ctx, photoPrompt([saved], entry.ctx.message.caption));
  const caption = entry.ctx.message.caption || `Проанализируй файл ${name}`;
  if (textual && size <= TEXT_INLINE_MAX) {
    const body = await fs.readFile(saved, 'utf8');
    return withReply(entry.ctx, `Пользователь отправил файл ${name} (${sizeLabel(size)}):\nФайл: ${saved}\n\n${body}\n\n${caption}`);
  }
  return withReply(entry.ctx, `Пользователь отправил файл ${name} (${sizeLabel(size)}).\nФайл сохранён: ${saved}\nОткрой и проанализируй.\n\n${caption}`);
}

export function canDownloadForwardedDocument(doc) {
  return Boolean(doc?.file_id && (doc.file_size || 0) <= MAX_BYTES);
}

/** Old batch caps apply to download attempts. A failed slot leaves later inputs intact. */
export async function prepareForwardedDocument(entry, botToken, signal, budget) {
  const doc = entry.ctx.message.document;
  const info = documentInfo(doc);
  const { name, size, image, textual } = info;
  const label = `файл ${name}${size ? ` (${sizeLabel(size)})` : ''}`;
  if (size > MAX_BYTES) return { label: `${label} — не скачан (>20MB, лимит Telegram)` };
  if (!doc.file_id) return { label: `${label} — не удалось скачать` };
  if (budget.downloads === 0) return { label: `${label} — не скачан (предел пачки)` };
  budget.downloads--;
  const inline = !image && textual && size <= TEXT_INLINE_MAX && budget.inline > 0;
  if (inline) budget.inline--;
  let saved;
  try { saved = await saveDocument(entry, botToken, signal, info); }
  catch {
    signal.throwIfAborted();
    return { label: `${label} — не удалось скачать` };
  }
  let content;
  if (inline) {
    try {
      if ((await fs.stat(saved)).size <= TEXT_INLINE_MAX) content = await fs.readFile(saved, { encoding: 'utf8', signal });
    } catch { signal.throwIfAborted(); }
  }
  return { name, label: `${label} — сохранён: ${saved}`, content };
}

async function prepareSticker(entry, botToken, signal) {
  const sticker = entry.ctx.message.sticker;
  if (!sticker) throw Error('Нет стикера в сообщении');
  const emoji = sticker.emoji || '';
  const set = sticker.set_name || '';
  const label = `Пользователь отправил стикер ${emoji}${set ? ` из набора "${set}"` : ''}`;
  if (sticker.is_animated || sticker.is_video) {
    const thumb = sticker.thumbnail?.file_id;
    if (thumb) {
      const file = await saveImage(entry.ctx.api, botToken, thumb, 'sticker_preview.jpg', { signal, env: entry.env });
      return withReply(entry.ctx, `${label}. Вот его превью:\nФайл: ${file}`);
    }
    return withReply(entry.ctx, `[Стикер: ${emoji}${set ? ` из набора "${set}"` : ''}]`);
  }
  const { bytes } = await downloadTelegramFile(entry.ctx.api, botToken, sticker.file_id, { signal });
  const file = await saveBytes(bytes, 'sticker.webp', entry.env);
  return withReply(entry.ctx, `${label}:\nФайл: ${file}`);
}

async function prepareAudio(entry, botToken, signal) {
  const audio = entry.ctx.message.audio;
  if (!audio) throw Error('Нет аудио в сообщении');
  const { bytes } = await downloadTelegramFile(entry.ctx.api, botToken, audio.file_id, {
    signal, sizeHint: audio.file_size,
  });
  const saved = await saveBytes(bytes, audio.file_name || 'audio.mp3', entry.env);
  const mime = audio.mime_type || 'audio/mpeg';
  let transcript = null;
  try {
    transcript = await tryTranscript(bytes, { signal, contentType: mime });
  } catch {
    transcript = null;
  }
  const caption = entry.ctx.message.caption || 'Проанализируй это аудио.';
  if (transcript) {
    return withReply(entry.ctx, `Пользователь отправил аудио. Файл: ${saved}\nТранскрипт: ${transcript}\n\n${caption}`);
  }
  return withReply(entry.ctx, `Пользователь отправил аудио. Файл сохранён: ${saved}\nРаспознавание речи недоступно или не удалось — открой файл при необходимости.\n\n${caption}`);
}

async function prepareAlbum(entry, botToken, signal) {
  const photos = entry.photos || [];
  const videos = entry.videos || [];
  const docs = entry.docs || [];
  const parts = [];
  const imagePaths = [];

  for (const photo of photos) {
    imagePaths.push(await saveImage(entry.ctx.api, botToken, photo.fileId, 'album_photo.jpg', {
      signal, sizeHint: photo.fileSize, env: entry.env,
    }));
  }
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const { bytes } = await downloadTelegramFile(entry.ctx.api, botToken, video.fileId, {
      signal, sizeHint: video.fileSize,
    });
    const saved = await saveBytes(bytes, `album_video_${i + 1}.mp4`, entry.env);
    const insights = await extractVideoInsights(bytes, video.duration || 0, { signal, isNote: video.isNote });
    parts.push(`--- Видео ${i + 1} (${video.duration || 0}с${video.isNote ? ', кружок' : ''}) ---\nФайл: ${saved}`);
    if (insights.transcript) parts.push(`Транскрипт: ${insights.transcript}`);
    for (const frame of insights.frames) imagePaths.push(frame);
    if (insights.frames.length) parts.push(`(${insights.frames.length} ключевых кадров приложены)`);
  }
  const docNotes = [];
  for (const doc of docs) {
    const ext = path.extname(doc.fileName).toLowerCase();
    if (doc.mimeType.startsWith('image/') || IMAGE_EXT.has(ext)) {
      imagePaths.push(await saveImage(entry.ctx.api, botToken, doc.fileId, doc.fileName, {
        signal, sizeHint: doc.fileSize, env: entry.env,
      }));
      docNotes.push(`🖼 ${doc.fileName}`);
      continue;
    }
    const saved = await downloadToWorkspace(entry.ctx.api, botToken, doc.fileId, doc.fileName, {
      signal, sizeHint: doc.fileSize, env: entry.env,
    });
    const textual = doc.mimeType.startsWith('text/') || TEXT_EXT.has(ext);
    if (textual && doc.fileSize <= TEXT_INLINE_MAX) {
      const body = await fs.readFile(saved, 'utf8');
      docNotes.push(`📄 ${doc.fileName} (${sizeLabel(doc.fileSize)}):\nФайл: ${saved}\n\n${body}`);
    } else {
      docNotes.push(`📄 ${doc.fileName} (${sizeLabel(doc.fileSize)})\nФайл сохранён: ${saved}\nОткрой и проанализируй.`);
    }
  }

  if (imagePaths.length) parts.unshift(photoPrompt(imagePaths, '', { includeTask: false }));
  if (docNotes.length) {
    parts.push(`Пользователь отправил ${docs.length} файл(ов):\n\n${docNotes.join('\n\n')}`);
  }
  const caption = entry.caption
    || (photos.length && videos.length ? 'Проанализируй медиа.'
      : photos.length > 1 ? `Галерея из ${photos.length} изображений. Проанализируй.`
        : videos.length > 1 ? `Галерея из ${videos.length} видео. Проанализируй.`
          : docs.length ? 'Проанализируй файлы'
            : photos.length ? 'Что на этом изображении?'
              : 'Проанализируй это видео.');
  const body = [...parts, caption].filter(Boolean).join('\n\n');
  if (!body.trim()) throw Error('Не удалось обработать медиа.');
  return withReply(entry.ctx, body, entry.referent);
}

/** Download/prepare one attachment entry into a model prompt. */
export async function prepareAttachment(entry, botToken, signal) {
  signal?.throwIfAborted?.();
  switch (entry.attachment) {
    case 'photo':
      return preparePhoto(entry, botToken, signal);
    case 'video':
      return prepareVideo(entry, botToken, signal);
    case 'animation':
      return prepareAnimation(entry, botToken, signal);
    case 'document':
      return prepareDocument(entry, botToken, signal);
    case 'sticker':
      return prepareSticker(entry, botToken, signal);
    case 'audio':
      return prepareAudio(entry, botToken, signal);
    case 'album':
      return prepareAlbum(entry, botToken, signal);
    default:
      throw Error(`Неизвестный тип вложения: ${entry.attachment}`);
  }
}

export function attachmentStatusText(kind) {
  switch (kind) {
    case 'photo':
      return '🖼 Анализирую...';
    case 'video':
      return '🎥 Анализирую видео...';
    case 'video_note':
      return '🎥 Анализирую кружок...';
    case 'animation':
      return '🎥 Анализирую GIF...';
    case 'document':
      return '📎 Получаю файл...';
    case 'sticker':
      return '🖼 Анализирую...';
    case 'audio':
      return '🎙 Расшифровываю...';
    case 'album':
      return '🗂 Обрабатываю медиа...';
    default:
      return '📎 Получаю вложение...';
  }
}

/**
 * Album collectors for photo/video/document media groups (old y5/SU, 2.5s quiet).
 * When ready, calls onReady(entry) so createBot can push into the shared inbox.
 */
export function createAttachmentAlbums({ onReady, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const albums = new Map();
  const docs = new Map();

  function schedule(map, id, entry) {
    clearTimer(entry.timer);
    entry.timer = setTimer(() => {
      map.delete(id);
      onReady(entry);
    }, ALBUM_QUIET_MS);
    entry.timer.unref?.();
  }

  function addPiece(map, groupId, piece, kind) {
    let entry = map.get(groupId);
    const referent = buildReplyContext(piece.ctx.message, piece.ctx.me?.id);
    if (!entry) {
      entry = { attachment: 'album', photos: [], videos: [], docs: [], ...piece, referent, startedAt: now() };
      map.set(groupId, entry);
    } else {
      entry[kind].push(...piece[kind]);
      if (piece.caption) entry.caption = piece.caption;
      if (referent) entry.referent = referent;
      entry.ctx = piece.ctx;
    }
    schedule(map, groupId, entry);
    return entry;
  }

  return {
    addPhoto: (groupId, piece) => addPiece(albums, groupId, piece, 'photos'),
    addVideo: (groupId, piece) => addPiece(albums, groupId, piece, 'videos'),
    addDocument: (groupId, piece) => addPiece(docs, groupId, piece, 'docs'),
    clear() {
      const entries = [...albums.values(), ...docs.values()];
      for (const entry of entries) clearTimer(entry.timer);
      albums.clear();
      docs.clear();
      return entries;
    },
  };
}
