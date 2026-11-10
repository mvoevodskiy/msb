#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Свободны ли имя-домен и имена в соцсетях: WHOIS/RDAP по зонам, публичные страницы t.me, fragment.com, vk.com.
// Бесплатно, без ключей и без входа. Признаки сверены живыми запросами 29.10.2026:
//  - whois.tcinet.ru (.ru/.рф/.su): свободен — «No entries found», занят — строка «domain:»;
//  - RDAP: 404 — свободен, 200 — занят; у .io и .me RDAP нет — WHOIS зоны по ссылке whois.iana.org;
//  - t.me/ИМЯ всегда отдаёт 200: занято, если есть блок tgme_page_title; fragment.com/username/ИМЯ —
//    статус в tm-section-header-status (Taken/Sold/For sale/On auction/Available), имени нет — 302 на /?query=;
//  - vk.com/ИМЯ без входа: занято — 200 со "screen_name":"ИМЯ" (или 302 на m.vk.com/ИМЯ при ином UA), адреса нет — 404.
// Если площадка поменяет разметку, разбор вернёт «не удалось проверить», а не догадку.

import net from 'node:net';
import { domainToASCII, domainToUnicode } from 'node:url';
import { parseArgs } from 'node:util';
import { asUsageError, type Deps, main, plural, UsageError } from './lib.ts';

export const DEFAULT_ZONES = ['ru', 'рф', 'com', 'net', 'org', 'io', 'app', 'info', 'online', 'pro', 'me', 'tech', 'news'];
/** Зоны Координационного центра: их WHOIS — whois.tcinet.ru, RDAP у них нет. */
export const TCI_ZONES = new Set(['ru', 'xn--p1ai', 'su']);
export const TCI_WHOIS = 'whois.tcinet.ru';
export const IANA_WHOIS = 'whois.iana.org';
export const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
/** Заголовок только ASCII: fetch не пускает кириллицу в заголовки. */
export const USER_AGENT = 'workspace-tools-names/1.0 (availability check; max 1 req/s per host)';
export const CONCURRENCY = 3;
export const INTERVAL_MS = 1000;
export const TIMEOUT_MS = 15_000;
export const MAX_NAMES = 20;

/** Имя в Telegram: 5–32 знака, латиница, цифры, «_», с буквы, не на «_», без «__». */
export const TG_RE = /^[a-z](?:[a-z0-9]|_(?!_)){3,30}[a-z0-9]$/;

export type Status = 'free' | 'likely_free' | 'taken' | 'reserved' | 'for_sale' | 'invalid' | 'not_applicable' | 'unknown';
export type Kind = 'domain' | 'social';

export interface Check {
  /** Зона без точки («ru», «рф») или площадка («tg», «vk»). */
  target: string;
  kind: Kind;
  /** Проверенный домен в Юникоде: «пример.рф». */
  domain?: string;
  status: Status;
  /** Статус по-русски, как в таблице. */
  label: string;
  /** Причина, премиальность, кто занял — то, что сказал сервер. */
  note?: string;
  /** Чей ответ: сервер WHOIS, хост RDAP, t.me, fragment.com, vk.com. */
  source?: string;
}

export interface NameResult {
  name: string;
  /** Нигде не занято и не «не удалось»; зоны не для этого письма («—») не мешают. */
  fullyFree: boolean;
  checks: Check[];
}

export interface Verdict {
  status: Status;
  note?: string;
}

export interface NamesDeps extends Deps {
  whois?: (host: string, query: string, timeoutMs: number) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  concurrency?: number;
  intervalMs?: number;
}

const LABELS: Record<Status, readonly [domain: string, social: string]> = {
  free: ['свободен', 'свободно'],
  likely_free: ['скорее свободен', 'скорее свободно'],
  taken: ['занят', 'занято'],
  reserved: ['зарезервирован', 'зарезервировано'],
  for_sale: ['продаётся', 'продаётся'],
  invalid: ['недопустимо', 'недопустимо'],
  not_applicable: ['—', '—'],
  unknown: ['не удалось проверить', 'не удалось проверить'],
};

export function statusLabel(status: Status, kind: Kind): string {
  return LABELS[status][kind === 'domain' ? 0 : 1];
}

const HELP = `Свободны ли имя-домен и имена в соцсетях. Бесплатно, без ключей и без входа.

  names.ts ИМЯ [ИМЯ…] [--zones ru,рф,com] [--social tg,vk] [--json]

  ИМЯ        без зоны: acme, а не acme.com; можно кириллицей (для .рф); до ${MAX_NAMES} имён за запуск
  --zones    зоны через запятую; по умолчанию: ${DEFAULT_ZONES.join(',')}
  --social   tg — Telegram (t.me и fragment.com), vk — ВКонтакте (vk.com); без флага соцсети не проверяются
  --json     массив [{ name, fullyFree, checks: [{ target, kind, domain?, status, label, note?, source? }] }];
             status: free, likely_free, taken, reserved, for_sale, invalid, not_applicable, unknown

Как проверяется:
  .ru, .рф, .su — WHOIS whois.tcinet.ru; остальные зоны — RDAP (сервер по списку IANA ${RDAP_BOOTSTRAP}),
  у зоны без RDAP — её WHOIS по ссылке whois.iana.org. Telegram — страница t.me/ИМЯ, затем fragment.com
  (имена, которые продаются за TON). ВКонтакте — vk.com/ИМЯ. Не больше ${CONCURRENCY} запросов одновременно,
  не чаще 1 в секунду на сервер, тайм-аут ${TIMEOUT_MS / 1000} с.

Правила имён: домен — латиница, цифры, дефис (не с краёв); .рф — только кириллица, .ru — только латиница.
  Telegram — 5–32 знака, латиница, цифры, «_», с буквы, не на «_». ВКонтакте — латиница, цифры, «_», «.».

Честно о точности:
  «свободен» по WHOIS/RDAP — не гарантия покупки: итог и цену (в том числе премиальную) показывает только
  регистратор. Премиальные и зарезервированные отмечаются, только если реестр сам это сообщает.
  «скорее свободно» в соцсетях — публичной страницы нет и Fragment имя не продаёт; площадка всё равно может
  не дать имя (зарезервировано, слишком короткое, запрещено правилами). Точно — только попыткой занять.

Код выхода: 0 — проверка прошла (даже если всё занято), 1 — не удалась ни одна проверка, 2 — неверный вызов.`;

// ---------- Разбор ответов (чистые функции, на них — тесты с образцами) ----------

const WHOIS_RESERVED = [
  /^\s*(?:domain\s+)?status:[^\n]*\breserved\b/im,
  /\b(?:domain|name)\s+(?:is\s+)?reserved\b/i,
  /\breserved\s+(?:by|for)\s+(?:the\s+)?regist/i,
  /\breserved\s+(?:domain|name)\b/i,
  /\bnot available for registration\b/i,
];
const WHOIS_FREE = [
  /^\s*No entries found\b/im,
  /^\s*%?\s*(?:Domain\s+)?not found\b/im,
  /^\s*No match(?:es)? for\b/im,
  /^\s*%?\s*No Data Found\b/im,
  /^\s*Status:\s*(?:free|available)\b/im,
  /\bThe queried object does not exist\b/i,
  /^\s*No Object Found\b/im,
  /^\s*%?\s*No such domain\b/im,
  /\bis available for registration\b/i,
  /^\s*No matching record\b/im,
];
const WHOIS_TAKEN = [/^\s*(?:domain(?:\s+name)?|domain_name)\s*:\s*\S/im, /^\s*Registry Domain ID:/im, /^\s*Status:\s*(?:connect|active|registered|ok)\b/im];
const RATE_LIMIT = /limit exceeded|too many (?:queries|requests|connections)|query rate|quota exceeded|try again later|exceeded (?:the )?(?:maximum|allowed)/i;
const PREMIUM = /\bpremium\b/i;
const DELETING = /pending\s*delete|redemption\s*period/i;

const PREMIUM_NOTE = 'премиальное — цена выше обычной (по словам реестра)';
const DELETING_NOTE = 'удаляется — может скоро освободиться';

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^[%#>]/.test(l));
  return (line ?? '').slice(0, 120);
}

export function parseWhois(text: string): Verdict {
  if (!text.trim()) return { status: 'unknown', note: 'пустой ответ WHOIS' };
  if (WHOIS_RESERVED.some((re) => re.test(text))) return { status: 'reserved', note: 'реестр сообщает: зарезервирован' };
  if (WHOIS_FREE.some((re) => re.test(text))) return PREMIUM.test(text) ? { status: 'free', note: PREMIUM_NOTE } : { status: 'free' };
  if (WHOIS_TAKEN.some((re) => re.test(text))) return DELETING.test(text) ? { status: 'taken', note: DELETING_NOTE } : { status: 'taken' };
  if (RATE_LIMIT.test(text)) return { status: 'unknown', note: `сервер ограничил частоту запросов: ${firstLine(text)}` };
  return { status: 'unknown', note: `ответ WHOIS не распознан: ${firstLine(text) || '(только комментарии)'}` };
}

/** Ответ whois.iana.org на запрос зоны: known — зона есть в корне, server — её WHOIS (если есть). */
export function parseIanaReferral(text: string): { known: boolean; server?: string } {
  if (/returned 0 objects|does not have any data/i.test(text)) return { known: false };
  const server = /^\s*(?:refer|whois):\s*(\S+)/im.exec(text)?.[1]?.toLowerCase();
  return { known: /^\s*domain:/im.test(text) || Boolean(server), server };
}

interface RdapJson {
  status?: unknown;
  description?: unknown;
  entities?: unknown;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Имена (vCard fn) регистраторов из entities ответа RDAP. */
function registrarNames(entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  const out: string[] = [];
  for (const e of entities as Array<{ roles?: unknown; vcardArray?: unknown }>) {
    if (!strings(e?.roles).includes('registrar')) continue;
    const props = Array.isArray(e.vcardArray) ? (e.vcardArray[1] as unknown) : undefined;
    if (!Array.isArray(props)) continue;
    for (const p of props) if (Array.isArray(p) && p[0] === 'fn' && typeof p[3] === 'string') out.push(p[3]);
  }
  return out;
}

export function parseRdap(status: number, body: string): Verdict {
  let json: RdapJson = {};
  try {
    json = JSON.parse(body) as RdapJson;
  } catch {
    // У 404 тело бывает пустым — это нормально.
  }
  if (status === 404) {
    const description = strings(json.description).join(' ');
    if (/reserved|not available|blocked|restricted/i.test(description)) return { status: 'reserved', note: `реестр: ${description.slice(0, 160)}` };
    return PREMIUM.test(description) ? { status: 'free', note: PREMIUM_NOTE } : { status: 'free' };
  }
  if (status === 200) {
    const statuses = strings(json.status).join(', ');
    const reservedBy = registrarNames(json.entities).find((n) => /reserved/i.test(n));
    if (reservedBy || /reserved/i.test(statuses)) return { status: 'reserved', note: `реестр: ${reservedBy ?? statuses}` };
    return DELETING.test(statuses) ? { status: 'taken', note: DELETING_NOTE } : { status: 'taken' };
  }
  if (status === 429) return { status: 'unknown', note: 'сервер RDAP ограничил частоту запросов (HTTP 429)' };
  return { status: 'unknown', note: `RDAP ответил HTTP ${status}` };
}

/** Список IANA «зона → базовый адрес RDAP» (https, с «/» на конце). */
export function parseBootstrap(json: unknown): Map<string, string> {
  const services = (json as { services?: unknown })?.services;
  if (!Array.isArray(services)) throw new Error('список RDAP IANA: нет services');
  const map = new Map<string, string>();
  for (const entry of services) {
    if (!Array.isArray(entry)) continue;
    const zones = strings(entry[0]);
    const urls = strings(entry[1]);
    const url = urls.find((u) => u.startsWith('https://')) ?? urls[0];
    if (!url) continue;
    const base = url.endsWith('/') ? url : `${url}/`;
    for (const z of zones) map.set(z.toLowerCase(), base);
  }
  return map;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Страница t.me/ИМЯ: taken — есть заголовок канала/пользователя; absent — заглушка «Contact @имя». */
export function parseTmePage(html: string): { state: 'taken' | 'absent' | 'unrecognized'; title?: string } {
  if (!/class="tgme_page[\s"_]/.test(html)) return { state: 'unrecognized' };
  if (!/class="tgme_page_title"/.test(html)) return { state: 'absent' };
  const og = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1];
  return { state: 'taken', title: og ? decodeHtml(og).trim() : undefined };
}

/** Статус на fragment.com/username/ИМЯ: «Taken», «Sold», «For sale», «On auction», «Available»… */
export function parseFragmentPage(html: string): string | undefined {
  const m = /class="tm-section-header-status[^"]*"[^>]*>\s*([^<]+?)\s*</.exec(html);
  return m ? decodeHtml(m[1]!) : undefined;
}

export function fragmentVerdict(fragmentStatus: string): Verdict {
  switch (fragmentStatus.toLowerCase()) {
    case 'taken':
      return { status: 'taken', note: 'Fragment: Taken — имя занято' };
    case 'sold':
      return { status: 'taken', note: 'Fragment: Sold — продано, у владельца' };
    case 'for sale':
      return { status: 'for_sale', note: 'Fragment: For sale — владелец продаёт' };
    case 'on auction':
      return { status: 'for_sale', note: 'Fragment: On auction — идёт аукцион' };
    case 'available':
      return { status: 'for_sale', note: 'Fragment: Available — Telegram отдаёт это имя только через аукцион Fragment' };
    case 'unavailable':
      // Так Fragment помечает имена, которые не продаёт (живая проверка 29.10: случайное имя).
      return { status: 'likely_free', note: 'Fragment: Unavailable — не продаётся' };
    default:
      return { status: 'unknown', note: `Fragment: незнакомый статус «${fragmentStatus}»` };
  }
}

/**
 * Ответ vk.com/ИМЯ без входа (redirect: manual). Живая проверка 29.10: с нашим User-Agent занятое имя —
 * 200 и в данных страницы "screen_name":"ИМЯ"; с иным UA — 302 на m.vk.com/ИМЯ; адреса нет — 404.
 * Служебные разделы (about, apps) — 200 без своего screen_name, feed — переход на вход: их не угадываем.
 */
export function vkVerdict(status: number, location: string | null, body: string, name: string): Verdict {
  if (status >= 300 && status < 400 && location) {
    let target: URL;
    try {
      target = new URL(location, 'https://vk.com');
    } catch {
      return { status: 'unknown', note: `ВК: странный адрес перехода ${location.slice(0, 100)}` };
    }
    if (target.pathname.toLowerCase() === `/${name}`) return { status: 'taken' };
    if (/challenge|captcha|blank\.php|login|join/i.test(target.host + target.pathname + target.search)) {
      return { status: 'unknown', note: `ВК потребовал проверку или вход (${target.host}${target.pathname}) — проверь вручную` };
    }
    return { status: 'taken', note: `адрес ведёт на ${target.host}${target.pathname}` };
  }
  if (status === 404) return { status: 'likely_free' };
  if (status === 429) return { status: 'unknown', note: 'ВК ограничил частоту запросов (HTTP 429)' };
  if (status === 200) {
    if (body.toLowerCase().includes(`"screen_name":"${name}"`)) return { status: 'taken' };
    return { status: 'unknown', note: 'ВК отдал страницу, но не профиль или сообщество с этим адресом (служебный раздел или проверка) — проверь вручную' };
  }
  return { status: 'unknown', note: `ВК ответил HTTP ${status}` };
}

/** Почему имя не годится для Telegram; undefined — годится. */
export function telegramProblem(name: string): string | undefined {
  if (TG_RE.test(name)) return undefined;
  if (!/^[a-z0-9_]+$/.test(name)) return 'в Telegram только латиница, цифры и «_»';
  if (name.length < 5 || name.length > 32) return 'в Telegram от 5 до 32 знаков';
  if (!/^[a-z]/.test(name)) return 'в Telegram имя начинается с буквы';
  if (name.endsWith('_')) return 'в Telegram имя не может кончаться на «_»';
  return 'в Telegram нельзя «__» подряд';
}

export function vkProblem(name: string): string | undefined {
  if (!/^[a-z0-9_.]+$/.test(name)) return 'в ВК только латиница, цифры, «_» и «.»';
  if (/^(?:id|club|public|event|app)\d+$/.test(name)) return 'служебный адрес ВК (id/club/public + номер)';
  return undefined;
}

export interface Zone {
  /** Как показывать: «рф». */
  display: string;
  /** Как спрашивать: «xn--p1ai». */
  ascii: string;
}

/** Почему имя не годится для домена в зоне; undefined — годится. */
export function domainProblem(name: string, zone: Zone): Verdict | undefined {
  if (name.includes('_')) return { status: 'invalid', note: 'в доменах нет «_»' };
  const cyrillic = /[а-яё]/.test(name);
  const nonAscii = /[^\x00-\x7f]/.test(name);
  if (zone.ascii === 'xn--p1ai' && (!cyrillic || !/^[а-яё0-9-]+$/.test(name))) return { status: 'not_applicable', note: 'в .рф — только кириллица' };
  if (zone.ascii === 'ru' && nonAscii) return { status: 'not_applicable', note: 'в .ru — только латиница' };
  const label = domainToASCII(name);
  const ldh = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
  if (!label || !ldh || (label.slice(2, 4) === '--' && !label.startsWith('xn--'))) {
    return { status: 'invalid', note: 'домен: буквы, цифры, дефис; не с дефиса и не на дефис, до 63 знаков' };
  }
  return undefined;
}

// ---------- Сеть: бережный планировщик, HTTP и WHOIS ----------

/**
 * Не больше limit запросов одновременно; к одному хосту — по одному и не чаще раза в intervalMs
 * (отсчёт от начала предыдущего запроса). Время и сон подменяются в тестах.
 */
export class Throttle {
  readonly #limit: number;
  readonly #intervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #clock: () => number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];
  readonly #tail = new Map<string, Promise<void>>();
  readonly #lastStart = new Map<string, number>();

  constructor(limit: number, intervalMs: number, sleep: (ms: number) => Promise<void>, clock: () => number) {
    this.#limit = limit;
    this.#intervalMs = intervalMs;
    this.#sleep = sleep;
    this.#clock = clock;
  }

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tail.get(host) ?? Promise.resolve();
    let unlock!: () => void;
    const mine = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.#tail.set(host, prev.then(() => mine));
    await prev;
    try {
      const last = this.#lastStart.get(host);
      if (last !== undefined) {
        const wait = last + this.#intervalMs - this.#clock();
        if (wait > 0) await this.#sleep(wait);
      }
      await this.#acquire();
      try {
        this.#lastStart.set(host, this.#clock());
        return await fn();
      } finally {
        this.#release();
      }
    } finally {
      unlock();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.#waiting.push(() => {
        this.#active++;
        resolve();
      }),
    );
  }

  #release(): void {
    this.#active--;
    this.#waiting.shift()?.();
  }
}

/** WHOIS по TCP 43: запрос строкой, ответ — всё до закрытия соединения. */
export function whoisQuery(host: string, query: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const socket = net.connect({ host, port: 43 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`нет ответа за ${Math.round(timeoutMs / 1000)} с`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${query}\r\n`));
    socket.on('data', (d: Buffer) => {
      size += d.length;
      if (size > 512_000) {
        socket.destroy();
        reject(new Error('слишком длинный ответ'));
      } else chunks.push(d);
    });
    socket.on('error', (e: NodeJS.ErrnoException) => reject(new Error(`сеть недоступна (${e.code ?? e.message})`)));
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

interface HttpResult {
  status: number;
  body: string;
  location: string | null;
}

class Ctx {
  readonly throttle: Throttle;
  readonly timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #whois: (host: string, query: string, timeoutMs: number) => Promise<string>;
  #bootstrap?: Promise<Map<string, string>>;
  readonly #zoneWhois = new Map<string, Promise<{ known: boolean; server?: string }>>();

  constructor(deps: NamesDeps) {
    this.timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
    this.#fetch = deps.fetch ?? fetch;
    this.#whois = deps.whois ?? whoisQuery;
    this.throttle = new Throttle(
      deps.concurrency ?? CONCURRENCY,
      deps.intervalMs ?? INTERVAL_MS,
      deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      deps.clock ?? Date.now,
    );
  }

  async get(url: string, init: { accept?: string; redirect?: RequestRedirect } = {}): Promise<HttpResult> {
    const host = new URL(url).host;
    return this.throttle.run(host, async () => {
      try {
        const res = await this.#fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: init.accept ?? 'text/html' },
          redirect: init.redirect ?? 'follow',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        return { status: res.status, body: await res.text(), location: res.headers.get('location') };
      } catch (error) {
        const err = error as Error & { cause?: { code?: string } };
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`${host}: нет ответа за ${Math.round(this.timeoutMs / 1000)} с`);
        throw new Error(`${host}: сеть недоступна (${err.cause?.code ?? err.message})`);
      }
    });
  }

  async whois(host: string, query: string): Promise<string> {
    return this.throttle.run(host, async () => {
      try {
        return await this.#whois(host, query, this.timeoutMs);
      } catch (error) {
        throw new Error(`${host}: ${(error as Error).message}`);
      }
    });
  }

  /** Список RDAP IANA — один раз за запуск. */
  rdapServers(): Promise<Map<string, string>> {
    this.#bootstrap ??= this.get(RDAP_BOOTSTRAP, { accept: 'application/json' }).then((res) => {
      if (res.status !== 200) throw new Error(`data.iana.org: HTTP ${res.status}`);
      try {
        return parseBootstrap(JSON.parse(res.body));
      } catch (error) {
        throw new Error(`data.iana.org: ${(error as Error).message}`);
      }
    });
    return this.#bootstrap;
  }

  /** WHOIS зоны по ссылке IANA — один раз на зону за запуск. */
  zoneWhois(zoneAscii: string): Promise<{ known: boolean; server?: string }> {
    let p = this.#zoneWhois.get(zoneAscii);
    if (!p) {
      p = this.whois(IANA_WHOIS, zoneAscii).then(parseIanaReferral);
      this.#zoneWhois.set(zoneAscii, p);
    }
    return p;
  }
}

// ---------- Проверки ----------

function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const list = notes.filter(Boolean);
  return list.length ? list.join('; ') : undefined;
}

function check(kind: Kind, target: string, verdict: Verdict, extra: { domain?: string; source?: string } = {}): Check {
  const c: Check = { target, kind, status: verdict.status, label: statusLabel(verdict.status, kind) };
  if (extra.domain) c.domain = extra.domain;
  if (verdict.note) c.note = verdict.note;
  if (extra.source) c.source = extra.source;
  return c;
}

async function lookupDomain(ctx: Ctx, ascii: string, zone: Zone): Promise<Verdict & { source: string }> {
  if (TCI_ZONES.has(zone.ascii)) return { ...parseWhois(await ctx.whois(TCI_WHOIS, ascii)), source: TCI_WHOIS };
  let bootstrapError: string | undefined;
  const servers = await ctx.rdapServers().catch((error: Error) => {
    bootstrapError = error.message;
    return undefined;
  });
  const rdap = servers?.get(zone.ascii);
  if (rdap) {
    const res = await ctx.get(`${rdap}domain/${ascii}`, { accept: 'application/rdap+json, application/json' });
    return { ...parseRdap(res.status, res.body), source: new URL(rdap).host };
  }
  const fallback = bootstrapError ? `список RDAP недоступен (${bootstrapError}), проверено по WHOIS` : undefined;
  const ref = await ctx.zoneWhois(zone.ascii);
  if (!ref.known) return { status: 'unknown', note: `зоны .${zone.display} нет в корневой зоне (IANA)`, source: IANA_WHOIS };
  if (!ref.server) return { status: 'unknown', note: joinNotes(`у зоны .${zone.display} нет ни RDAP, ни WHOIS (по данным IANA)`, fallback), source: IANA_WHOIS };
  const verdict = parseWhois(await ctx.whois(ref.server, ascii));
  return { ...verdict, note: joinNotes(verdict.note, fallback), source: ref.server };
}

async function checkDomain(ctx: Ctx, name: string, zone: Zone): Promise<Check> {
  const problem = domainProblem(name, zone);
  if (problem) return check('domain', zone.display, problem);
  const ascii = `${domainToASCII(name)}.${zone.ascii}`;
  const domain = `${name}.${zone.display}`;
  const idn = /[^\x00-\x7f]/.test(name) && zone.ascii !== 'xn--p1ai' ? 'кириллица: уточни у регистратора, принимает ли зона такие имена' : undefined;
  try {
    const v = await lookupDomain(ctx, ascii, zone);
    return check('domain', zone.display, { status: v.status, note: joinNotes(v.note, idn) }, { domain, source: v.source });
  } catch (error) {
    return check('domain', zone.display, { status: 'unknown', note: (error as Error).message }, { domain });
  }
}

async function checkTelegram(ctx: Ctx, name: string): Promise<Check> {
  const problem = telegramProblem(name);
  if (problem) return check('social', 'tg', { status: 'invalid', note: problem });
  try {
    const page = await ctx.get(`https://t.me/${name}`);
    const tme = page.status === 200 ? parseTmePage(page.body) : undefined;
    if (!tme || tme.state === 'unrecognized') {
      return check('social', 'tg', { status: 'unknown', note: `t.me: страница не распознана (HTTP ${page.status})` }, { source: 't.me' });
    }
    if (tme.state === 'taken') return check('social', 'tg', { status: 'taken', note: tme.title ? `«${tme.title}»` : undefined }, { source: 't.me' });
  } catch (error) {
    return check('social', 'tg', { status: 'unknown', note: (error as Error).message }, { source: 't.me' });
  }
  // На t.me имени нет — но Telegram мог придержать его для продажи на Fragment.
  try {
    const res = await ctx.get(`https://fragment.com/username/${name}`, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      if (res.location?.includes('query=')) return check('social', 'tg', { status: 'likely_free' }, { source: 't.me, fragment.com' });
      return check('social', 'tg', { status: 'unknown', note: `Fragment: неожиданный переход на ${res.location ?? '?'}` }, { source: 'fragment.com' });
    }
    if (res.status !== 200) return check('social', 'tg', { status: 'unknown', note: `на t.me имени нет, но Fragment ответил HTTP ${res.status}` }, { source: 'fragment.com' });
    const status = parseFragmentPage(res.body);
    if (!status) return check('social', 'tg', { status: 'unknown', note: 'на t.me имени нет, страница Fragment не распознана' }, { source: 'fragment.com' });
    return check('social', 'tg', fragmentVerdict(status), { source: 'fragment.com' });
  } catch (error) {
    return check('social', 'tg', { status: 'unknown', note: `на t.me имени нет, но ${(error as Error).message}` }, { source: 'fragment.com' });
  }
}

async function checkVk(ctx: Ctx, name: string): Promise<Check> {
  const problem = vkProblem(name);
  if (problem) return check('social', 'vk', { status: 'invalid', note: problem });
  try {
    const res = await ctx.get(`https://vk.com/${name}`, { redirect: 'manual' });
    return check('social', 'vk', vkVerdict(res.status, res.location, res.body, name), { source: 'vk.com' });
  } catch (error) {
    return check('social', 'vk', { status: 'unknown', note: (error as Error).message }, { source: 'vk.com' });
  }
}

// ---------- Разбор вызова и вывод ----------

export function parseZones(raw: string | undefined): Zone[] {
  const list = raw === undefined ? DEFAULT_ZONES : raw.split(/[\s,]+/).filter(Boolean);
  if (!list.length) throw new UsageError('--zones: пустой список зон');
  const zones: Zone[] = [];
  for (const item of list) {
    const ascii = domainToASCII(item.trim().toLowerCase().replace(/^\.+/, ''));
    if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(ascii)) throw new UsageError(`--zones: неверная зона «${item}»`);
    if (!zones.some((z) => z.ascii === ascii)) zones.push({ display: domainToUnicode(ascii), ascii });
  }
  return zones;
}

const SOCIAL_ALIASES: Record<string, 'tg' | 'vk'> = { tg: 'tg', telegram: 'tg', vk: 'vk', вк: 'vk', vkontakte: 'vk' };
const SOCIAL_TITLES: Record<string, string> = { tg: 'Telegram', vk: 'ВКонтакте' };

export function parseSocial(raw: string | undefined): Array<'tg' | 'vk'> {
  if (raw === undefined) return [];
  const out: Array<'tg' | 'vk'> = [];
  for (const item of raw.split(/[\s,]+/).filter(Boolean)) {
    const key = SOCIAL_ALIASES[item.toLowerCase()];
    if (!key) throw new UsageError(`--social: неизвестная площадка «${item}», есть tg и vk`);
    if (!out.includes(key)) out.push(key);
  }
  if (!out.length) throw new UsageError('--social: пустой список, есть tg и vk');
  return out;
}

export function parseNames(positionals: string[]): string[] {
  if (!positionals.length) throw new UsageError('Укажи хотя бы одно имя: names.ts acme');
  const names: string[] = [];
  for (const raw of positionals) {
    const name = raw.trim().replace(/^@/, '').toLowerCase();
    if (name.includes('.')) throw new UsageError(`Имя без зоны: «${name.split('.')[0]}», а не «${name}»; зоны — через --zones`);
    if (!/^[\p{L}\p{N}_-]{1,63}$/u.test(name)) throw new UsageError(`Неверное имя «${raw}»: буквы, цифры, «-» и «_», до 63 знаков`);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > MAX_NAMES) throw new UsageError(`Не больше ${MAX_NAMES} имён за запуск: серверы ограничивают частоту запросов`);
  return names;
}

const FREE_LIKE = new Set<Status>(['free', 'likely_free', 'not_applicable']);

export function isFullyFree(checks: Check[]): boolean {
  return checks.some((c) => c.status === 'free' || c.status === 'likely_free') && checks.every((c) => FREE_LIKE.has(c.status));
}

function targetTitle(c: Check): string {
  return c.kind === 'domain' ? `.${c.target}` : (SOCIAL_TITLES[c.target] ?? c.target);
}

const COLUMNS_PER_BLOCK = 4;

export function renderText(results: NameResult[], zones: Zone[], socials: string[]): string {
  const lines: string[] = [];
  const parts = [`${zones.length} ${plural(zones.length, ['зона', 'зоны', 'зон'])}`, ...socials.map((s) => SOCIAL_TITLES[s]!)];
  lines.push(`Свободны ли имена: ${parts.join(', ')}`);
  const rowTitles = results[0]?.checks.map(targetTitle) ?? [];
  for (let i = 0; i < results.length; i += COLUMNS_PER_BLOCK) {
    const block = results.slice(i, i + COLUMNS_PER_BLOCK);
    const head = ['', ...block.map((r) => r.name)];
    const rows = rowTitles.map((title, j) => [title, ...block.map((r) => r.checks[j]!.label)]);
    const widths = head.map((_, k) => Math.max(...[head, ...rows].map((row) => row[k]!.length)));
    const fmt = (row: string[]) => row.map((cell, k) => (k === row.length - 1 ? cell : cell.padEnd(widths[k]!))).join('  ');
    lines.push('', fmt(head), ...rows.map(fmt));
  }
  // Одинаковые пояснения (например, «в .рф — только кириллица») — одной строкой на все имена.
  const notes = new Map<string, string[]>();
  for (const r of results) {
    for (const c of r.checks) {
      if (!c.note) continue;
      const key = `${targetTitle(c)}: ${c.note}`;
      notes.set(key, [...(notes.get(key) ?? []), r.name]);
    }
  }
  if (notes.size) {
    lines.push('', 'Пояснения:');
    for (const [key, names] of notes) lines.push(`  ${names.join(', ')} · ${key}`);
  }
  const free = results.filter((r) => r.fullyFree).map((r) => r.name);
  lines.push('', `Полностью свободно: ${free.length ? free.join(', ') : 'нет'}`);
  lines.push('«Свободен» по WHOIS/RDAP — не гарантия покупки: итог и цену показывает только регистратор.');
  if (socials.length) lines.push('«Скорее свободно» — публичной страницы нет; точно — только попыткой занять имя.');
  return lines.join('\n');
}

export async function run(argv: string[], deps: NamesDeps): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        zones: { type: 'string' },
        social: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    asUsageError(error);
  }
  const { values, positionals } = parsed;
  if (values.help) return HELP;
  const names = parseNames(positionals);
  const zones = parseZones(values.zones);
  const socials = parseSocial(values.social);

  const ctx = new Ctx(deps);
  const results: NameResult[] = await Promise.all(
    names.map(async (name) => {
      const checks = await Promise.all([
        ...zones.map((zone) => checkDomain(ctx, name, zone)),
        ...socials.map((s) => (s === 'tg' ? checkTelegram(ctx, name) : checkVk(ctx, name))),
      ]);
      return { name, fullyFree: isFullyFree(checks), checks };
    }),
  );

  const performed = results.flatMap((r) => r.checks).filter((c) => c.status !== 'invalid' && c.status !== 'not_applicable');
  if (performed.length && performed.every((c) => c.status === 'unknown')) process.exitCode = 1;
  return values.json ? JSON.stringify(results) : renderText(results, zones, socials);
}

main(import.meta.url, run);
