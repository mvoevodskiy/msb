/**
 * Model final -> Telegram HTML/plan/footer; shared pure HTML length/split utilities.
 * Caller [bot](./bot.mjs); prepared [views](./view-delivery.mjs) use only pure exports.
 * [Response checks](../../tests/response-delivery.test.mjs), [plan checks](../../tests/plan-handoff.test.mjs).
 */
import { parsePlanResponse, planKeyboard } from './plan.mjs';
import { presentationSignal } from './presentation-api.mjs';

// Compact final delivery from the old u4/$u/editFinal contract, without its
// streaming/runtime machinery. Telemetry must be supplied by the caller.
const LIMIT = 4000;
const TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'a', 'tg-spoiler']);
const ENTITY = /^&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/i;
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescape = (text) => text.replace(/&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/gi, (entity) => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };
  if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()];
  const hex = /^&#x/i.test(entity);
  const cp = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
});
const escapeText = (text) => escape(unescape(String(text)));

// The old Hu presentation rules, applied only to text outside code/pre.
function inlineNames(text) {
  return text
    .replace(/(?<![<\/\w.])(@[a-zA-Z0-9_]{2,})(?![^<]*>)/g, '<code>$1</code>')
    .replace(/(?<![<\/\w])(\b[\w.-]+\.(md|ts|js|py|json|yaml|yml|toml|txt|csv|sql|sh|html|css|xml|env|log|cjs|mjs)\b)(?![^<]*>)/gi, '<code>$1</code>');
}

function safeTag(raw) {
  const match = /^<(\/)?([a-z][\w-]*)([^>]*)>$/i.exec(raw);
  if (!match) return null;
  const name = ({ strong: 'b', em: 'i', ins: 'u', strike: 's', del: 's' })[match[2].toLowerCase()] || match[2].toLowerCase();
  if (!TAGS.has(name)) return null;
  if (match[1]) return { name, close: true, raw: `</${name}>` };
  if (name === 'a') {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[3]);
    const url = href && unescape(href[1] ?? href[2]);
    if (!url || !/^(?:https?:|tg:|mailto:)/i.test(url) || /[\r\n\0]/.test(url)) return null;
    return { name, close: false, raw: `<a href="${escape(url).replace(/"/g, '&quot;')}">` };
  }
  return { name, close: false, raw: `<${name}>` };
}

/** Common old Markdown forms and Telegram HTML; unknown tags remain visible text. */
export function renderResponseHtml(value) {
  const input = String(value ?? '').toWellFormed();
  const saved = [];
  const hold = (value) => `\0${saved.push(value) - 1}\0`;
  let body = input.replace(/\0/g, '�');
  body = body.replace(/<(pre|code)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_all, name, code) => {
    const tag = name.toLowerCase();
    const inner = tag === 'pre' && /^<code(?:\s[^>]*)?>([\s\S]*?)<\/code>$/i.exec(code);
    return hold(inner ? `<pre><code>${escapeText(inner[1])}</code></pre>` : `<${tag}>${escapeText(code)}</${tag}>`);
  });
  body = body.replace(/```(?:[\w+-]+)?\n([\s\S]*?)```/g, (_all, code) => hold(`<pre><code>${escape(code.trimEnd())}</code></pre>`));
  body = body.replace(/`([^`\n]+)`/g, (_all, code) => hold(`<code>${escape(code)}</code>`));
  body = body.replace(/<[^>]*>/g, (raw) => {
    const tag = safeTag(raw);
    return tag ? hold(tag.raw) : raw;
  });
  body = escapeText(body)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
    .replace(/(?<=\s|^)_(.+?)_(?=\s|$)/gm, '<i>$1</i>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (raw, label, url) => {
      const tag = safeTag(`<a href="${unescape(url).replace(/"/g, '&quot;')}">`);
      return tag ? `${tag.raw}${label}</a>` : raw;
    })
    .replace(/^(\s*)[-—•]\s/gm, '$1[x] ');
  body = body.replace(/\0(\d+)\0/g, (_all, index) => saved[Number(index)]);

  // Balance accepted markup before splitting. Bound wrapper size/depth so a long
  // link or pathological nesting cannot prevent the chunker from making progress.
  const stack = [];
  let html = '';
  for (const part of body.split(/(<[^>]*>)/g)) {
    if (!part) continue;
    if (!part.startsWith('<')) {
      html += stack.includes('code') || stack.includes('pre') ? part : inlineNames(part);
      continue;
    }
    const tag = safeTag(part);
    if (!tag) { html += escape(part); continue; }
    if (tag.close) {
      if (stack.at(-1) === tag.name) { stack.pop(); html += tag.raw; }
      else html += escape(part);
    } else if (stack.length < 12 && tag.raw.length < 1000 && !(tag.name === 'a' && stack.includes('a'))) {
      stack.push(tag.name); html += tag.raw;
    } else html += escape(part);
  }
  return html + stack.reverse().map((name) => `</${name}>`).join('');
}

export function formatTurnFooter({ elapsedMs, costUsd, context } = {}) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return '';
  const parts = [`⏱ ${(elapsedMs / 1000).toFixed(1)}s`];
  if (Number.isFinite(costUsd) && costUsd >= 0.001) parts.push(`$${costUsd.toFixed(3)}`);
  const used = context?.contextTokens;
  const limit = context?.contextWindow;
  if (Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(limit) && limit > 0) {
    const percent = Math.max(0, Math.min(100, Math.round(used / limit * 100)));
    if (percent >= 5) {
      const dots = percent <= 20 ? '○○○' : percent <= 40 ? '●○○' : percent <= 60 ? '●●○' : '●●●';
      parts.push(`${dots} ${percent}%`);
    }
  }
  return `\n\n<blockquote>${parts.join(' · ')}</blockquote>`;
}

/** Encoded HTML -> visible UTF16 units for Telegram's after-entities text budget. */
export const visibleHtmlLength = html => unescape(String(html).replace(/<[^>]*>/g, '')).length;

/** Balanced pure splitter shared by final responses and readonly [views](./view-delivery.mjs). */
export function splitHtml(html, limit, {keepInlineCode = false} = {}) {
  const chunks = [];
  const stack = [];
  let chunk = '', content = false;
  const closing = () => [...stack].reverse().map((tag) => `</${tag.name}>`).join('');
  const flush = () => {
    if (!content) throw new Error('Response markup exceeds Telegram chunk capacity');
    chunks.push(chunk + closing());
    chunk = stack.map((tag) => tag.raw).join('');
    content = false;
  };
  const parts = html.split(/(<[^>]*>)/g);
  for (const [index, part] of parts.entries()) {
    if (!part) continue;
    const tag = part.startsWith('<') ? safeTag(part) : null;
    if (tag) {
      // UI command names must remain copyable when their whole code span fits.
      // Model responses keep the original splitting policy unless opted in.
      if (keepInlineCode && !tag.close && tag.name === 'code') {
        const end = safeTag(parts[index + 2] || '');
        if (end?.close && end.name === 'code') {
          const size = tag.raw.length + parts[index + 1].length + end.raw.length;
          const wrappers = stack.reduce((total, item) => total + item.raw.length, 0) + closing().length;
          if (content && size + wrappers <= limit && chunk.length + size + closing().length > limit) flush();
        }
      }
      const overhead = tag.close ? -tag.raw.length : `</${tag.name}>`.length;
      if (chunk.length + tag.raw.length + closing().length + overhead > limit) flush();
      chunk += tag.raw;
      if (tag.close) stack.pop(); else stack.push(tag);
      continue;
    }
    for (let index = 0; index < part.length;) {
      const entity = part[index] === '&' && ENTITY.exec(part.slice(index));
      const unit = entity ? entity[0] : String.fromCodePoint(part.codePointAt(index));
      if (chunk.length + unit.length + closing().length > limit) flush();
      chunk += unit;
      content = true;
      index += unit.length;
    }
  }
  if (content || !chunks.length) chunks.push(chunk + closing());
  return chunks;
}

function options(ctx, html = true, editing = false) {
  const thread = (ctx.message || ctx.callbackQuery?.message)?.message_thread_id;
  return {
    ...(html ? { parse_mode: 'HTML' } : {}),
    ...(!editing && thread && thread !== 1 ? { message_thread_id: thread } : {}),
    link_preview_options: { is_disabled: true },
  };
}

async function send(ctx, html, keyboard) {
  const markup = keyboard ? { reply_markup: keyboard } : {};
  try { return await ctx.reply(html, { ...options(ctx), ...markup }); }
  catch (err) {
    if (!/parse|unsupported.*tag|entit/i.test(String(err?.description || err?.message || err))) throw err;
    return ctx.reply(unescape(html.replace(/<[^>]*>/g, '')), { ...options(ctx, false), ...markup });
  }
}

/**
 * Final text → Telegram: ordinary short edit, long chunks, old plan separate card.
 * [plan parser/keyboard](./plan.mjs) runs here, never in progress; footer + markup
 * only on the final chunk, including plain fallback. Error notices can opt out.
 * [createBot](./bot.mjs) owns cancellation; [delivery tests](../../tests/plan-handoff.test.mjs).
 */
export async function deliverTurnResponse(ctx, statusId, text, telemetry = {}, { allowPlan = true, restoreText = value => value } = {}) {
  const plan = allowPlan && parsePlanResponse(text);
  const body = renderResponseHtml(restoreText(plan ? plan.cleanText : text || 'Ответ не пришёл — попробуй ещё раз.'));
  const footer = formatTurnFooter(telemetry);
  const complete = body + footer;
  if (complete.length <= LIMIT && !plan) {
    if (statusId) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, statusId, complete, options(ctx, true, true), presentationSignal(AbortSignal.timeout(15_000)));
        return { method: 'edit', messages: 1 };
      } catch (err) {
        if (/not modified/i.test(String(err?.description || err?.message || err))) return { method: 'edit', messages: 1 };
      }
      // Only the bot's supplied status ID; never the incoming user message.
      await ctx.api.deleteMessage(ctx.chat.id, statusId, presentationSignal(AbortSignal.timeout(15_000))).catch(() => {});
    }
    await send(ctx, complete);
    return { method: 'send', messages: 1 };
  }
  if (statusId) await ctx.api.deleteMessage(ctx.chat.id, statusId, presentationSignal(AbortSignal.timeout(15_000))).catch(() => {});
  const chunks = splitHtml(body, LIMIT - footer.length);
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    await send(ctx, chunks[i] + (last ? footer : ''), last && plan ? planKeyboard(plan.pattern) : undefined);
  }
  return { method: 'send', messages: chunks.length };
}
