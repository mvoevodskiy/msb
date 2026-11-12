/**
 * Queued media descriptor → Telegram send* after the text answer.
 * Old F9Q/C9Q: local path or http(s) URL; optional H.264 convert for video.
 * Caller [bot](./bot.mjs); markers → [media-markers](./media-markers.mjs).
 * Checks: [send-media](../../tests/send-media.test.mjs).
 */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { InputFile } from 'grammy';
import { workspaceDir } from '../paths.mjs';

const exec = promisify(execFile);
const PHOTO_MAX = 10 * 1024 * 1024;
const OTHER_MAX = 50 * 1024 * 1024;

function threadOptions(threadId) {
  if (!threadId || threadId === 1) return {};
  return { message_thread_id: threadId };
}

function resolvePath(filePath, env = process.env) {
  if (/^https?:\/\//i.test(filePath)) return filePath;
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceDir(env), filePath);
}

async function ensureVideoTelegram(filePath) {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'json', filePath,
    ], { timeout: 10_000 });
    const streams = JSON.parse(stdout)?.streams || [];
    const codec = streams.find(s => s.codec_type === 'video' || s.codec_name)?.codec_name;
    if (!codec || codec === 'h264') return filePath;
    const out = filePath.replace(/\.[^.]+$/, '') + '_tg.mp4';
    await exec('ffmpeg', [
      '-i', filePath, '-c:v', 'libx264', '-crf', '23', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', out,
    ], { timeout: 300_000 });
    const size = (await fs.stat(out)).size;
    if (size > 51_380_224) {
      await exec('ffmpeg', [
        '-i', filePath, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-crf', '28',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-y', out,
      ], { timeout: 300_000 });
    }
    return out;
  } catch (err) {
    console.error(`[msb/bot] video convert skipped: ${err.message}`);
    return filePath;
  }
}

async function toInput(filePath, type) {
  if (/^https?:\/\//i.test(filePath)) return filePath;
  let local = filePath;
  if (type === 'video') local = await ensureVideoTelegram(filePath);
  const bytes = await fs.readFile(local);
  return new InputFile(bytes, path.basename(local) || 'file');
}

/** Send one media item; missing/oversized files throw for the caller log. */
export async function sendMediaItem(api, chatId, item, { threadId, env = process.env } = {}) {
  const resolved = resolvePath(item.path, env);
  if (!/^https?:\/\//i.test(resolved)) {
    const stat = await fs.stat(resolved);
    const limit = item.type === 'photo' ? PHOTO_MAX : OTHER_MAX;
    if (stat.size > limit) {
      throw Error(`Файл слишком большой: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    }
  }
  const media = await toInput(resolved, item.type);
  const options = { ...threadOptions(threadId) };
  if (item.caption && item.type !== 'sticker') options.caption = item.caption;
  switch (item.type) {
    case 'photo':
      return api.sendPhoto(chatId, media, options);
    case 'voice':
      return api.sendVoice(chatId, media, options);
    case 'video':
      return api.sendVideo(chatId, media, options);
    case 'audio':
      return api.sendAudio(chatId, media, options);
    case 'animation':
      return api.sendAnimation(chatId, media, options);
    case 'sticker':
      return api.sendSticker(chatId, media, options);
    case 'document':
    default:
      return api.sendDocument(chatId, media, options);
  }
}

/** Deliver queued media after the text answer; failures are logged, not fatal. */
export async function sendMediaQueue(api, chatId, items, { threadId, env = process.env, log = console.error } = {}) {
  for (const item of items) {
    try {
      await sendMediaItem(api, chatId, item, { threadId, env });
    } catch (err) {
      log(`[msb/bot] send_media failed (${item.type}): ${err.message}`);
    }
  }
}
