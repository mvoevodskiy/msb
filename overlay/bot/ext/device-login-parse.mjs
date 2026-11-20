/**
 * Общий разбор URL/кода из вывода device/browser login CLI.
 * Совпадает с парсером Codex в [auth-wire](./auth-wire.mjs); Grok/Cursor переиспользуют его.
 */
import { stripVTControlCharacters } from 'node:util';

export function extractDeviceLoginInfo(stdout = '', stderr = '') {
  // CLI output can contain terminal colours and arrive in several chunks.
  // Parse each stream separately so a synthetic separator never completes
  // a device code whose final character has not arrived yet.
  const streams = [stdout, stderr].map(stripVTControlCharacters);
  const text = streams.join('\n');
  const url = streams.map((stream) =>
    stream.match(/https?:\/\/[^\s]+(?=\s)/i)?.[0]?.replace(/[),.;]+$/, '')
  ).find(Boolean) || null;
  const dashed = streams.map((stream) =>
    stream.match(/\b([A-Z0-9]{4,}-[A-Z0-9-]{4,})(?=[\s),.;!])/)
  ).find(Boolean)?.[1];
  const labelled = streams.flatMap((stream) =>
    Array.from(stream.matchAll(/\bcode[:\s]+([a-z0-9-]{4,})(?=[\s),.;!])/gi), (match) => match[1])
  ).find((value) => /^[A-Z0-9-]+$/.test(value));
  const code = dashed || labelled || null;
  return { url, code, text };
}
