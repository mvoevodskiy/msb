import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../lib.ts';
import {
  type Check,
  fragmentVerdict,
  isFullyFree,
  type NameResult,
  type NamesDeps,
  parseBootstrap,
  parseFragmentPage,
  parseIanaReferral,
  parseRdap,
  parseTmePage,
  parseWhois,
  RDAP_BOOTSTRAP,
  run,
  telegramProblem,
  Throttle,
  USER_AGENT,
  vkVerdict,
} from '../names.ts';

// ---------- Образцы ответов (сокращённые копии живых, 29.10.2026) ----------

const TCI_TAKEN = `% TCI Whois Service. Terms of use:
% https://tcinet.ru/documents/whois_ru_rf.pdf (in Russian)
% https://tcinet.ru/documents/whois_su.pdf (in Russian)

domain:        YANDEX.RU
nserver:       ns1.yandex.ru. 213.180.193.1, 2a02:6b8::1
state:         REGISTERED, DELEGATED, VERIFIED
registrar:     RU-CENTER-RU
created:       1997-09-23T09:45:07Z
paid-till:     2027-09-30T21:00:00Z
free-date:     2027-11-01
source:        TCI

Last updated on 2026-10-29T11:08:01Z
`;

const TCI_FREE = `% TCI Whois Service. Terms of use:
% https://tcinet.ru/documents/whois_ru_rf.pdf (in Russian)
% https://tcinet.ru/documents/whois_su.pdf (in Russian)

No entries found for the selected source(s).

Last updated on 2026-10-29T11:08:01Z
`;

const NIC_IO_FREE = `Domain not found.
>>> Last update of WHOIS database: 2026-10-29T11:10:42Z <<<

Terms of Use: Access to WHOIS information is provided to assist persons in determining the contents of a domain name registration record in the registry database. Whois is not considered authoritative for registered domain objects. Identity Digital Inc. and Registry Operator reserve the right to modify these terms at any time.
`;

const NIC_IO_TAKEN = `This domain is protected by the Registry Lock service.

Domain Name: google.io
Registry Domain ID: REDACTED
Registrar WHOIS Server: whois.markmonitor.com
Domain Status: clientDeleteProhibited https://icann.org/epp#clientDeleteProhibited
`;

const IANA_IO = `% IANA WHOIS server
% for more information on IANA, visit http://www.iana.org

domain:       IO
organisation: Internet Computer Bureau Limited
whois:        whois.nic.io
status:       ACTIVE
`;

const IANA_NONE = `% IANA WHOIS server
% This query returned 0 objects.
%
% You queried for zz but this server does not have
% any data for zz.
`;

const TME_TAKEN = `<html><head><meta property="og:title" content="Tom &amp; Jerry"></head><body>
<div class="tgme_page">
<div class="tgme_page_title" dir="auto">
  <span dir="auto">Tom &amp; Jerry</span><i class="verified-icon"> ✔</i>
</div>
<div class="tgme_page_extra">10 208 793 subscribers</div>
</div></body></html>`;

const TME_ABSENT = `<html><head><meta property="og:title" content="Telegram: Contact @qzxv8k3m2w9p7t5r"></head><body>
<div class="tgme_page">
  <div class="tgme_page_icon"><i class="tgme_icon_user"></i></div>
  <div class="tgme_page_description">If you have <strong>Telegram</strong>, you can contact
  <a class="tgme_username_link" href="tg://resolve?domain=qzxv8k3m2w9p7t5r">@qzxv8k3m2w9p7t5r</a> right away.</div>
</div></body></html>`;

function fragmentPage(status: string, cls = 'tm-status-avail'): string {
  return `<h2 class="tm-section-header-text">
  <span class="tm-section-header-domain"><span class="tm-web3-address"><span class="subdomain">qwxyz</span><span class="domain">.t.me</span></span></span>
  <span class="tm-section-header-status ${cls}">${status}</span>
</h2>`;
}

const VK_TAKEN = (name: string) => `<!DOCTYPE html><html><head><script>window.vk = { id: 0 };</script></head>
<body><script>var data = {"owner_id":-11283947,"screen_name":"${name}","name":"Яндекс"};</script></body></html>`;
const VK_SECTION = `<!DOCTYPE html><html><body><script>var apps = [{"screen_name":"app52444576"}];</script></body></html>`;

const BOOTSTRAP = {
  version: '1.0',
  services: [
    [['com', 'net'], ['https://rdap.verisign.com/com/v1/']],
    [['org'], ['http://rdap.example/org', 'https://rdap.publicinterestregistry.org/rdap']],
    [['APP', 'dev'], ['https://pubapi.registry.google/rdap/']],
  ],
};

// ---------- Подменная сеть ----------

type Reply = { status?: number; body?: string; headers?: Record<string, string> } | Error;

interface WebCall {
  url: string;
  headers: Record<string, string>;
  redirect?: string;
}

/** Подменный fetch: маршрут — функция от URL; ответ отдаётся через тик, чтобы запросы могли пересекаться. */
function web(route: (url: URL) => Reply | undefined) {
  const calls: WebCall[] = [];
  let active = 0;
  const stats = { maxActive: 0 };
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
    active++;
    stats.maxActive = Math.max(stats.maxActive, active);
    try {
      await new Promise((r) => setImmediate(r));
      const hit = route(new URL(url));
      if (hit instanceof Error) throw hit;
      if (!hit) return new Response('not found', { status: 404 });
      return new Response(hit.body ?? '', { status: hit.status ?? 200, headers: hit.headers });
    } finally {
      active--;
    }
  };
  return { fetch: impl as typeof fetch, calls, stats };
}

function whoisFake(answer: (host: string, query: string) => string | Error) {
  const calls: Array<{ host: string; query: string }> = [];
  const whois = async (host: string, query: string): Promise<string> => {
    calls.push({ host, query });
    await new Promise((r) => setImmediate(r));
    const a = answer(host, query);
    if (a instanceof Error) throw a;
    return a;
  };
  return { whois, calls };
}

const noSleep = async () => {};

function deps(over: Partial<NamesDeps>): NamesDeps {
  return { env: {}, sleep: noSleep, ...over };
}

async function json(argv: string[], d: NamesDeps): Promise<NameResult[]> {
  return JSON.parse(await run([...argv, '--json'], d)) as NameResult[];
}

function byTarget(result: NameResult, target: string): Check {
  const c = result.checks.find((x) => x.target === target);
  assert.ok(c, `нет проверки ${target}`);
  return c;
}

// ---------- WHOIS ----------

test('WHOIS: занят / свободен / не распознан на образцах tcinet и Identity Digital', () => {
  assert.equal(parseWhois(TCI_TAKEN).status, 'taken');
  assert.deepEqual(parseWhois(TCI_FREE), { status: 'free' });
  // «reserve the right» в условиях — не признак резерва.
  assert.deepEqual(parseWhois(NIC_IO_FREE), { status: 'free' });
  assert.equal(parseWhois(NIC_IO_TAKEN).status, 'taken');
  assert.deepEqual(parseWhois('No match for "QZXV.COM".\r\n>>> Last update <<<\r\nAll rights reserved.'), { status: 'free' });
  assert.deepEqual(parseWhois('Domain: qzxv.de\nStatus: free\n'), { status: 'free' });
  const bad = parseWhois('hello world');
  assert.equal(bad.status, 'unknown');
  assert.match(bad.note!, /не распознан: hello world/);
  assert.equal(parseWhois('  \n').status, 'unknown');
});

test('WHOIS: резерв, премиальное, удаление, ограничение частоты', () => {
  assert.equal(parseWhois('Domain Name: x.io\nDomain Status: reserved\n').status, 'reserved');
  assert.equal(parseWhois('The domain name is reserved by the registry.').status, 'reserved');
  assert.deepEqual(parseWhois('Domain not found.\nThis is a Premium domain.'), { status: 'free', note: 'премиальное — цена выше обычной (по словам реестра)' });
  assert.deepEqual(parseWhois('Domain Name: x.com\nDomain Status: pendingDelete\n'), { status: 'taken', note: 'удаляется — может скоро освободиться' });
  const limited = parseWhois('%ERROR:201: access denied - query rate limit exceeded, try again later');
  assert.equal(limited.status, 'unknown');
  assert.match(limited.note!, /ограничил частоту/);
});

test('IANA: ссылка на WHOIS зоны, зоны нет, зона без WHOIS', () => {
  assert.deepEqual(parseIanaReferral(IANA_IO), { known: true, server: 'whois.nic.io' });
  assert.deepEqual(parseIanaReferral(IANA_NONE), { known: false });
  assert.deepEqual(parseIanaReferral('domain:       XX\nstatus: ACTIVE\n'), { known: true, server: undefined });
});

// ---------- RDAP ----------

test('RDAP: 200 — занят, 404 — свободен, резерв и удаление по ответу реестра, прочее — не удалось', () => {
  assert.deepEqual(parseRdap(200, '{"objectClassName":"domain","ldhName":"YANDEX.COM","status":["client transfer prohibited"]}'), { status: 'taken' });
  const reserved = parseRdap(200, JSON.stringify({ entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'RESERVED-Internet Assigned Numbers Authority']]] }] }));
  assert.equal(reserved.status, 'reserved');
  assert.match(reserved.note!, /RESERVED-Internet/);
  assert.deepEqual(parseRdap(200, '{"status":["pending delete"]}'), { status: 'taken', note: 'удаляется — может скоро освободиться' });
  assert.deepEqual(parseRdap(404, ''), { status: 'free' });
  assert.deepEqual(parseRdap(404, '{"errorCode":404,"description":["Domain a.online is available for registration"]}'), { status: 'free' });
  assert.equal(parseRdap(404, '{"description":["This name is reserved by the registry"]}').status, 'reserved');
  assert.deepEqual(parseRdap(500, 'oops'), { status: 'unknown', note: 'RDAP ответил HTTP 500' });
  assert.equal(parseRdap(429, '').status, 'unknown');
});

test('бутстрап IANA: https в приоритете, «/» на конце, зоны в нижнем регистре; без services — ошибка', () => {
  const map = parseBootstrap(BOOTSTRAP);
  assert.equal(map.get('com'), 'https://rdap.verisign.com/com/v1/');
  assert.equal(map.get('org'), 'https://rdap.publicinterestregistry.org/rdap/');
  assert.equal(map.get('app'), 'https://pubapi.registry.google/rdap/');
  assert.equal(map.get('io'), undefined);
  assert.throws(() => parseBootstrap({ foo: 1 }), /services/);
});

test('RDAP через run: 200/404/500/тайм-аут, бутстрап один раз на запуск, User-Agent', async () => {
  const net = web((url) => {
    if (url.href === RDAP_BOOTSTRAP) return { body: JSON.stringify(BOOTSTRAP) };
    if (url.pathname.endsWith('/domain/yandex.com')) return { body: '{"objectClassName":"domain"}' };
    if (url.pathname.endsWith('.com')) return { status: 404, body: '' };
    if (url.host === 'rdap.publicinterestregistry.org') return { status: 500, body: 'boom' };
    if (url.host === 'pubapi.registry.google') return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return undefined;
  });
  const out = await json(['yandex', 'qzxv8k3m2w9p7t5r', '--zones', 'com,org,app'], deps({ fetch: net.fetch, timeoutMs: 5000 }));
  assert.deepEqual(
    out.map((r) => r.checks.map((c) => c.status)),
    [
      ['taken', 'unknown', 'unknown'],
      ['free', 'unknown', 'unknown'],
    ],
  );
  const [yandex, rnd] = out;
  assert.deepEqual(byTarget(yandex!, 'com'), { target: 'com', kind: 'domain', domain: 'yandex.com', status: 'taken', label: 'занят', source: 'rdap.verisign.com' });
  assert.equal(byTarget(rnd!, 'org').note, 'RDAP ответил HTTP 500');
  assert.equal(byTarget(rnd!, 'app').note, 'pubapi.registry.google: нет ответа за 5 с');
  assert.equal(net.calls.filter((c) => c.url === RDAP_BOOTSTRAP).length, 1);
  assert.ok(net.calls.some((c) => c.url === 'https://rdap.publicinterestregistry.org/rdap/domain/yandex.org'));
  for (const c of net.calls) assert.equal(c.headers['User-Agent'], USER_AGENT);
  assert.match(net.calls.find((c) => c.url.includes('/domain/'))!.headers.Accept!, /rdap\+json/);
});

test('зона без RDAP — WHOIS по ссылке IANA (один запрос к IANA на зону); неизвестная зона; бутстрап недоступен', async () => {
  const net = web((url) => (url.href === RDAP_BOOTSTRAP ? { body: JSON.stringify(BOOTSTRAP) } : undefined));
  const w = whoisFake((host, q) => {
    if (host === 'whois.iana.org') return q === 'io' ? IANA_IO : IANA_NONE;
    if (host === 'whois.nic.io') return q === 'google.io' ? NIC_IO_TAKEN : NIC_IO_FREE;
    return new Error('нет ответа за 15 с');
  });
  const out = await json(['google', 'acme', '--zones', 'io,zz'], deps({ fetch: net.fetch, whois: w.whois }));
  assert.deepEqual(byTarget(out[0]!, 'io'), { target: 'io', kind: 'domain', domain: 'google.io', status: 'taken', label: 'занят', source: 'whois.nic.io' });
  assert.equal(byTarget(out[1]!, 'io').status, 'free');
  assert.equal(byTarget(out[1]!, 'zz').status, 'unknown');
  assert.match(byTarget(out[1]!, 'zz').note!, /нет в корневой зоне/);
  assert.equal(w.calls.filter((c) => c.host === 'whois.iana.org' && c.query === 'io').length, 1);

  const down = web(() => new TypeError('fetch failed'));
  const w2 = whoisFake((host) => (host === 'whois.iana.org' ? IANA_IO : NIC_IO_FREE));
  const [r] = await json(['acme', '--zones', 'com'], deps({ fetch: down.fetch, whois: w2.whois }));
  const c = byTarget(r!, 'com');
  assert.equal(c.status, 'free');
  assert.match(c.note!, /список RDAP недоступен \(data\.iana\.org: сеть недоступна/);
});

// ---------- .ru / .рф и punycode ----------

test('.ru и .рф — whois.tcinet.ru; .рф — punycode; письмо не для зоны — «—»; «_» — недопустимо', async () => {
  const w = whoisFake((host, q) => {
    assert.equal(host, 'whois.tcinet.ru');
    return q === 'yandex.ru' || q === 'xn--e1afmkfd.xn--p1ai' ? TCI_TAKEN : TCI_FREE;
  });
  const net = web((url) => (url.href === RDAP_BOOTSTRAP ? { body: JSON.stringify(BOOTSTRAP) } : { status: 404, body: '' }));
  const out = await json(['yandex', 'пример', 'новое', 'my_name', '--zones', 'ru,.РФ,com'], deps({ whois: w.whois, fetch: net.fetch }));
  assert.deepEqual(
    out.map((r) => [r.name, ...r.checks.map((c) => c.status)]),
    [
      ['yandex', 'taken', 'not_applicable', 'free'],
      ['пример', 'not_applicable', 'taken', 'free'],
      ['новое', 'not_applicable', 'free', 'free'],
      ['my_name', 'invalid', 'invalid', 'invalid'],
    ],
  );
  assert.equal(byTarget(out[1]!, 'рф').domain, 'пример.рф');
  assert.equal(byTarget(out[0]!, 'рф').note, 'в .рф — только кириллица');
  assert.equal(byTarget(out[1]!, 'ru').note, 'в .ru — только латиница');
  assert.match(byTarget(out[1]!, 'com').note!, /кириллица: уточни у регистратора/);
  assert.ok(net.calls.some((c) => c.url === 'https://rdap.verisign.com/com/v1/domain/xn--e1afmkfd.com'));
  assert.deepEqual(w.calls.map((c) => c.query).sort(), ['xn--b1agweb.xn--p1ai', 'xn--e1afmkfd.xn--p1ai', 'yandex.ru'].sort());
  // Полностью свободно: «—» не мешает, «недопустимо» и «занят» — мешают.
  assert.deepEqual(
    out.map((r) => r.fullyFree),
    [false, false, true, false],
  );
});

test('WHOIS не ответил — «не удалось проверить» с сервером в причине', async () => {
  const w = whoisFake(() => new Error('нет ответа за 15 с'));
  const [r] = await json(['acme', '--zones', 'ru'], deps({ whois: w.whois }));
  assert.deepEqual(byTarget(r!, 'ru'), { target: 'ru', kind: 'domain', domain: 'acme.ru', status: 'unknown', label: 'не удалось проверить', note: 'whois.tcinet.ru: нет ответа за 15 с' });
  process.exitCode = 0;
});

// ---------- Telegram ----------

test('правила имён Telegram', () => {
  for (const ok of ['acme', 'a2345', 'a_b_c1', `a${'b'.repeat(31)}`]) assert.equal(telegramProblem(ok), undefined, ok);
  const bad: Array<[string, RegExp]> = [
    ['abcd', /от 5 до 32/],
    [`a${'b'.repeat(32)}`, /от 5 до 32/],
    ['1abcd', /с буквы/],
    ['_abcd', /с буквы/],
    ['abcd_', /кончаться/],
    ['ab__cd', /«__»/],
    ['ab-cd', /латиница/],
    ['привет', /латиница/],
  ];
  for (const [name, re] of bad) assert.match(telegramProblem(name)!, re, name);
});

test('страницы t.me и Fragment: разбор образцов', () => {
  assert.deepEqual(parseTmePage(TME_TAKEN), { state: 'taken', title: 'Tom & Jerry' });
  assert.deepEqual(parseTmePage(TME_ABSENT), { state: 'absent' });
  assert.deepEqual(parseTmePage('<html>Cloudflare challenge</html>'), { state: 'unrecognized' });
  assert.equal(parseFragmentPage(fragmentPage('Taken', 'tm-status-taken')), 'Taken');
  assert.equal(parseFragmentPage(fragmentPage('On auction')), 'On auction');
  assert.equal(parseFragmentPage('<html></html>'), undefined);
  const expected: Array<[string, string]> = [
    ['Taken', 'taken'],
    ['Sold', 'taken'],
    ['For sale', 'for_sale'],
    ['On auction', 'for_sale'],
    ['Available', 'for_sale'],
    ['Unavailable', 'likely_free'],
    ['Something new', 'unknown'],
  ];
  for (const [s, status] of expected) assert.equal(fragmentVerdict(s).status, status, s);
});

test('Telegram через run: занято на t.me (Fragment не спрашиваем), продаётся на Fragment, скорее свободно, недопустимо, сбои', async () => {
  const net = web((url) => {
    if (url.host === 't.me') {
      if (url.pathname === '/durov') return { body: TME_TAKEN };
      if (url.pathname === '/tmedown') return new TypeError('fetch failed');
      return { body: TME_ABSENT };
    }
    if (url.host === 'fragment.com') {
      if (url.pathname === '/username/qwxyz') return { body: fragmentPage('Available') };
      if (url.pathname === '/username/fragdown') return { status: 500, body: '' };
      return { status: 302, headers: { location: `https://fragment.com/?query=${url.pathname.split('/').pop()}` } };
    }
    return undefined;
  });
  const out = await json(['durov', 'qwxyz', 'freename', 'abc', 'tmedown', 'fragdown', '--zones', 'ru', '--social', 'tg'], deps({ fetch: net.fetch, whois: async () => TCI_FREE }));
  const tg = Object.fromEntries(out.map((r) => [r.name, byTarget(r, 'tg')]));
  assert.deepEqual(tg.durov, { target: 'tg', kind: 'social', status: 'taken', label: 'занято', note: '«Tom & Jerry»', source: 't.me' });
  assert.equal(tg.qwxyz!.status, 'for_sale');
  assert.match(tg.qwxyz!.note!, /только через аукцион Fragment/);
  assert.deepEqual(tg.freename, { target: 'tg', kind: 'social', status: 'likely_free', label: 'скорее свободно', source: 't.me, fragment.com' });
  assert.deepEqual(tg.abc, { target: 'tg', kind: 'social', status: 'invalid', label: 'недопустимо', note: 'в Telegram от 5 до 32 знаков' });
  assert.equal(tg.tmedown!.status, 'unknown');
  assert.match(tg.tmedown!.note!, /t\.me: сеть недоступна/);
  assert.equal(tg.fragdown!.status, 'unknown');
  assert.match(tg.fragdown!.note!, /Fragment ответил HTTP 500/);
  assert.ok(!net.calls.some((c) => c.url.includes('fragment.com/username/durov')));
  assert.ok(!net.calls.some((c) => c.url.includes('/abc')));
  assert.equal(net.calls.find((c) => c.url.includes('fragment.com'))!.redirect, 'manual');
  assert.equal(out.find((r) => r.name === 'freename')!.fullyFree, true);
});

// ---------- ВКонтакте ----------

test('ВК: признаки занятого и свободного адреса на образцах', () => {
  assert.deepEqual(vkVerdict(200, null, VK_TAKEN('yandex'), 'yandex'), { status: 'taken' });
  assert.equal(vkVerdict(200, null, VK_SECTION, 'apps').status, 'unknown');
  assert.deepEqual(vkVerdict(302, 'https://m.vk.com/durov', '', 'durov'), { status: 'taken' });
  assert.deepEqual(vkVerdict(302, 'https://m.vk.com/public11283947', '', 'yandex'), { status: 'taken', note: 'адрес ведёт на m.vk.com/public11283947' });
  assert.equal(vkVerdict(302, 'https://login.vk.com/?to=aHR0cHM6Ly92ay5jb20vZmVlZA--', '', 'feed').status, 'unknown');
  assert.equal(vkVerdict(302, 'https://vk.com/challenge.html?x=1', '', 'durov').status, 'unknown');
  assert.deepEqual(vkVerdict(404, null, '<html></html>', 'qzxv8k3m2w9p7t5r'), { status: 'likely_free' });
  assert.match(vkVerdict(429, null, '', 'x').note!, /частоту/);
  assert.match(vkVerdict(503, null, '', 'x').note!, /HTTP 503/);
});

test('ВК через run: занято, скорее свободно, недопустимо, без перехода по редиректам', async () => {
  const net = web((url) => {
    if (url.pathname === '/yandex') return { body: VK_TAKEN('yandex') };
    if (url.pathname === '/durov') return { status: 302, headers: { location: 'https://m.vk.com/durov' } };
    return { status: 404, body: '<html></html>' };
  });
  const out = await json(['yandex', 'durov', 'qzxv8k3m2w9p7t5r', 'my-name', 'id123', '--zones', 'ru', '--social', 'vk'], deps({ fetch: net.fetch, whois: async () => TCI_FREE }));
  assert.deepEqual(
    out.map((r) => byTarget(r, 'vk').status),
    ['taken', 'taken', 'likely_free', 'invalid', 'invalid'],
  );
  assert.equal(byTarget(out[0]!, 'vk').label, 'занято');
  assert.equal(net.calls.length, 3);
  for (const c of net.calls) assert.equal(c.redirect, 'manual');
});

// ---------- Бережность ----------

test('планировщик: не больше 3 одновременно, к одному хосту — по одному и не чаще раза в секунду', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const throttle = new Throttle(
    3,
    1000,
    async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    () => now,
  );
  let active = 0;
  let maxActive = 0;
  const perHost = new Map<string, { active: number; max: number; starts: number[] }>();
  const tasks = [];
  for (let i = 0; i < 24; i++) {
    const host = `h${i % 6}`;
    tasks.push(
      throttle.run(host, async () => {
        const h = perHost.get(host) ?? { active: 0, max: 0, starts: [] };
        perHost.set(host, h);
        h.starts.push(now);
        h.active++;
        h.max = Math.max(h.max, h.active);
        active++;
        maxActive = Math.max(maxActive, active);
        for (let k = 0; k < 3; k++) await new Promise((r) => setImmediate(r));
        active--;
        h.active--;
        return i;
      }),
    );
  }
  assert.deepEqual(await Promise.all(tasks), [...Array(24).keys()]);
  assert.equal(maxActive, 3);
  for (const [host, h] of perHost) {
    assert.equal(h.max, 1, host);
    for (let k = 1; k < h.starts.length; k++) assert.ok(h.starts[k]! - h.starts[k - 1]! >= 1000, `${host}: ${h.starts.join(',')}`);
  }
  assert.ok(sleeps.length > 0);
});

test('run: при многих именах и зонах в сети не больше 3 запросов одновременно', async () => {
  const net = web((url) => (url.href === RDAP_BOOTSTRAP ? { body: JSON.stringify(BOOTSTRAP) } : { status: 404, body: '' }));
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const out = await json([...names, '--zones', 'com,net,org,app,dev'], deps({ fetch: net.fetch }));
  assert.equal(out.length, 6);
  assert.ok(out.every((r) => r.fullyFree));
  assert.ok(net.stats.maxActive <= 3, `одновременно: ${net.stats.maxActive}`);
  assert.equal(net.calls.length, 1 + 6 * 5);
});

// ---------- Вывод, коды выхода, неверный вызов ----------

test('таблица по-русски: имена — столбцы (по 4 в блоке), пояснения сгруппированы, итог', async () => {
  const w = whoisFake((_, q) => (q === 'yandex.ru' ? TCI_TAKEN : TCI_FREE));
  const net = web((url) => (url.host === 't.me' ? { body: url.pathname === '/yandex' ? TME_TAKEN : TME_ABSENT } : { status: 302, headers: { location: '/?query=x' } }));
  const out = await run(['yandex', 'acme', 'bravo', 'charlie', 'delta', '--zones', 'ru,рф', '--social', 'tg'], deps({ whois: w.whois, fetch: net.fetch }));
  const lines = out.split('\n');
  assert.equal(lines[0], 'Свободны ли имена: 2 зоны, Telegram');
  assert.match(out, /^ +yandex +acme +bravo +charlie$/m);
  assert.match(out, /^\.ru +занят +свободен +свободен +свободен$/m);
  assert.match(out, /^ +delta$/m);
  assert.match(out, /^Telegram +занято +скорее свободно/m);
  assert.match(out, /^ {2}yandex, acme, bravo, charlie, delta · \.рф: в \.рф — только кириллица$/m);
  assert.match(out, /^ {2}yandex · Telegram: «Tom & Jerry»$/m);
  assert.match(out, /^Полностью свободно: acme, bravo, charlie, delta$/m);
  assert.match(out, /не гарантия покупки/);
  assert.match(out, /Скорее свободно/);
});

test('коды выхода: всё не удалось — 1; хоть что-то проверено (даже всё занято) или всё недопустимо — 0', async () => {
  const failing = whoisFake(() => new Error('сеть недоступна (ECONNREFUSED)'));
  process.exitCode = 0;
  await run(['acme', 'bravo', '--zones', 'ru'], deps({ whois: failing.whois }));
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;

  const taken = whoisFake(() => TCI_TAKEN);
  const out = await run(['yandex', '--zones', 'ru'], deps({ whois: taken.whois }));
  assert.equal(process.exitCode, 0);
  assert.match(out, /Полностью свободно: нет/);

  await run(['my_name', '--zones', 'ru'], deps({ whois: failing.whois }));
  assert.equal(process.exitCode, 0);
  assert.equal(failing.calls.length, 2);
});

test('--json — массив объектов по именам', async () => {
  const w = whoisFake(() => TCI_FREE);
  const out = await json(['ZapCita', '@acme', '--zones', 'ru'], deps({ whois: w.whois }));
  assert.deepEqual(out, [
    { name: 'acme', fullyFree: true, checks: [{ target: 'ru', kind: 'domain', domain: 'acme.ru', status: 'free', label: 'свободен', source: 'whois.tcinet.ru' }] },
  ]);
  assert.equal(isFullyFree([]), false);
});

test('неверный вызов — UsageError без сети; --help — справка', async () => {
  const net = web(() => undefined);
  const w = whoisFake(() => TCI_FREE);
  const d = deps({ fetch: net.fetch, whois: w.whois });
  const cases: string[][] = [
    [],
    ['--bogus', 'x'],
    ['acme.com'],
    ['bad name!'],
    ['x', '--zones', 'c_m'],
    ['x', '--zones', ','],
    ['x', '--social', 'fb'],
    ['x', '--social', ''],
    ['x', '--zones'],
    Array.from({ length: 21 }, (_, i) => `name${i}`),
  ];
  for (const argv of cases) await assert.rejects(run(argv, d), UsageError, argv.join(' '));
  const help = await run(['--help'], d);
  assert.match(help, /names\.ts ИМЯ/);
  assert.match(help, /не гарантия покупки/);
  assert.match(help, /Код выхода/);
  assert.equal(net.calls.length + w.calls.length, 0);
});
