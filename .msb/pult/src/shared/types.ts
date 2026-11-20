// Общий контракт «Пульта»: снимок состояния, который сборщик собирает на сервере ботов
// и отправляет веб-сервису (POST /api/ingest). Веб-сервис хранит последний снимок и историю,
// интерфейс рисует всё только из снимка и /api/history.
//
// Правила для всех частей:
// - Время — строки ISO 8601 в UTC; в МСК переводит только интерфейс и тексты Telegram.
// - Названия платформы ботов, её служб и путей к её файлам в снимок НЕ попадают: только
//   человеческие имена из конфига («Основной», «SMM», «Личный»).
// - Чего не удалось прочитать — не выдумывать: поле null + запись в sourceErrors.

export const SNAPSHOT_SCHEMA = 1;

export type Iso = string;

/** Итог одного хода фоновой задачи или таймера. missed — ход по расписанию должен был быть, но не случился. */
export type RunStatus = 'ok' | 'silent' | 'error' | 'missed';

/** Уровень важности. crit — «нужно действие», serious/warn — «требует внимания». */
export type Level = 'crit' | 'serious' | 'warn';

export type Tab = 'overview' | 'bots' | 'tasks' | 'projects' | 'server';

export interface Snapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  /** Имя источника для людей, например «Сервер ботов». */
  host: string;
  collectedAt: Iso;
  /** Сколько миллисекунд занял сбор. */
  collectMs: number;
  server: ServerState;
  bots: Bot[];
  /** Фоновые задачи ботов и таймеры сервера, уже отсортированы: требующие внимания сверху, затем по имени. */
  tasks: Task[];
  /** Сколько фоновых задач выключено или отработало (разовые) — показываются свёрнутыми. */
  tasksHidden: number;
  services: Service[];
  /** Служебные процессы платформы ботов — только счётчики, без имён. */
  platform: { total: number; ok: number; failed: number };
  projects: Project[];
  asks: Ask[];
  /** Что требует внимания — посчитано правилами в сборщике (src/collector/analyze.ts). */
  attention: Attention[];
  subscription: Subscription | null;
  /** Per-provider quotas; legacy subscription remains Claude-only. */
  subscriptions?: Subscription[];
  balances: Balance[];
  /** Ближайшие запуски (до 8 штук), по времени. */
  upcoming: Upcoming[];
  sourceErrors: SourceError[];
}

export interface ServerState {
  cores: number;
  /** Занятость процессора, % за последний интервал сбора (100 − idle − iowait... см. sources/system.ts). */
  cpuPct: number;
  iowaitPct: number;
  load1: number;
  memTotalMb: number;
  /** Занято без кэша: total − available. */
  memUsedMb: number;
  memCacheMb: number;
  memAvailMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  diskTotalGb: number;
  diskUsedGb: number;
  bootAt: Iso;
}

export interface Bot {
  /** Внутренний ключ из конфига: default | SMM | personal. */
  id: string;
  name: string;
  projects: string[];
  service: ServiceHealth;
  now: BotNow;
  lastResult: { at: Iso; text: string; durationMin: number; actions: number | null } | null;
  chat24h: { requests: number; minutes: number };
  bg24h: { tasks: number; runs: number; tokens: number; minutes: number };
  /** Отрезки за последние 24 часа: чаты и фоновые ходы. */
  timeline: Span[];
}

export interface BotNow {
  busy: boolean;
  since: Iso | null;
  kind: 'chat' | 'task' | null;
  /** О чём запрос: начало текста запроса или имя задачи, до 120 символов. */
  text: string | null;
  /** Сколько помощников сейчас работает (процессов агента сверх основного). */
  helpers: number;
}

export interface Span {
  start: Iso;
  end: Iso;
  kind: 'chat' | 'bg';
  status?: RunStatus;
  /** Подпись для подсказки при наведении. */
  label?: string;
  /** Идёт сейчас: end = момент сбора. */
  live?: boolean;
}

export interface ServiceHealth {
  /** active | inactive | failed | activating | deactivating | unknown */
  state: string;
  since: Iso | null;
  restarts: number;
  memMb: number | null;
  /** Среднее число занятых ядер с момента запуска службы. */
  cpuCores: number | null;
}

export interface Task {
  id: string;
  name: string;
  /** Ключ бота или 'server' для таймеров сервера. */
  bot: string;
  botName: string;
  project: string | null;
  kind: 'reminder' | 'prompt' | 'draft' | 'digest' | 'timer' | 'other';
  schedule: Schedule;
  /** Чего ждать от задачи — одной фразой. */
  expect: string | null;
  /** Без ИИ (таймер-скрипт) — токенов не тратит. */
  noAi: boolean;
  lastRun: Run | null;
  nextRunAt: Iso | null;
  stats24h: TaskStats;
  /** Слоты за 24 часа по порядку: для полоски. Для задач по событию — только фактические ходы. */
  slots24h: RunStatus[];
  /** Ходы за 30 дней, по времени (старые первыми). */
  runs: Run[];
  /** Пропуски: непрерывные интервалы, когда ходов по расписанию не было. */
  gaps: { from: Iso; to: Iso; missed: number }[];
  attention: Level | null;
  attentionText: string | null;
  pulse: Pulse | null;
  /** Коммиты проекта задачи за 30 дней (если задача — разработка в git-проекте). */
  commits: { at: Iso; hash: string; subject: string }[];
}

export interface Schedule {
  type: 'cron' | 'once' | 'event' | 'interval';
  /** По-русски: «каждый час», «ежедневно 08:00», «каждые 3 ч», «разово», «по событию: …». */
  text: string;
  cron?: string;
  timezone?: string;
  /** Для type=interval: период в секундах. */
  everySec?: number;
}

export interface TaskStats {
  /** Сколько ходов должно было быть за 24 ч по расписанию (null — не считается: событие, разовая). */
  expected: number | null;
  runs: number;
  ok: number;
  silent: number;
  error: number;
  missed: number;
  tokens: number;
  minutes: number;
  usd: number;
}

export interface Run {
  at: Iso;
  status: RunStatus;
  durationSec: number;
  tokens: number;
  helpers: number;
  /** Оценка по тарифу API в $, если журнал её даёт. По подписке не списывается. */
  usd: number | null;
  detail: string | null;
}

export interface Pulse {
  updatedAt: Iso;
  phase: string | null;
  text: string | null;
  /** Ожидаемое следующее обновление; просрочено при незаконченном ходе — пульс несвежий. */
  nextBy: Iso | null;
  fresh: boolean;
}

export interface Service extends ServiceHealth {
  /** Внутренний ключ из конфига (не имя юнита платформы). */
  id: string;
  name: string;
  project: string | null;
  /** Тяжёлая: попала в «требует внимания» по памяти или процессору. */
  heavy: boolean;
}

export interface Project {
  id: string;
  name: string;
  /** Кто ведёт: «основной бот · соцсети — SMM». */
  owner: string;
  status: 'ok' | 'warn' | 'pause' | 'unknown';
  statusText: string;
  stage: string | null;
  next: string | null;
  services: { name: string; state: string }[];
  commitsToday: number | null;
  lastCommit: { at: Iso; subject: string } | null;
  /** Свободные факты: «Тесты» → «6 037 зелёных». */
  facts: { label: string; value: string }[];
  /** Короткие формулировки открытых вопросов к Михаилу по проекту. */
  asks: string[];
  updatedAt: Iso | null;
}

export interface Ask {
  id: string;
  project: string | null;
  /** Ключ бота, который спросил. */
  bot: string;
  botName: string;
  text: string;
  /** Что стоит без ответа. */
  blocks: string | null;
  since: Iso;
}

export interface Attention {
  /** Стабильный ключ: по нему веб-сервис отличает новую проблему от старой. */
  key: string;
  level: Level;
  text: string;
  /** Проект, к которому относится (задача, служба); null — общее (сервер, бот, подписка). */
  project: string | null;
  link: { tab: Tab; id?: string };
  since: Iso | null;
}

export interface Subscription {
  providerId?: string;
  stale?: boolean;
  windows?: { usedPercent: number; windowMinutes: number; resetsAt: Iso }[];
  /** allowed | limited | … как отдаёт платформа. */
  status: string;
  resetsAt: Iso | null;
  windowType: string | null;
  overage: boolean;
  updatedAt: Iso;
}

export interface Balance {
  id: string;
  name: string;
  /** Готовая строка для показа: «334,75 ₽», «$0,005 из $5». */
  value: string;
  ok: boolean | null;
  checkedAt: Iso | null;
  stale: boolean;
  note: string | null;
}

export interface Upcoming {
  at: Iso;
  name: string;
  taskId: string;
}

export interface SourceError {
  source: string;
  message: string;
}

// ---- API веб-сервиса ----

/** GET /api/history?range=24h|7d|30d — ряды для графиков сервера. t — ISO (начало корзины усреднения:
 *  5 мин / 30 мин / 2 ч), значения в процентах. Пустые корзины не отдаются — графики строить по времени, а не по номеру точки. */
export interface HistoryResponse {
  range: '24h' | '7d' | '30d';
  points: { t: Iso; cpu: number; mem: number; disk: number; swap: number }[];
}

/** GET /api/snapshot — последний снимок и его свежесть. */
export interface SnapshotResponse {
  snapshot: Snapshot | null;
  receivedAt: Iso | null;
  /** Сколько секунд назад пришёл снимок. */
  ageSec: number | null;
  /** Снимок старше порога: интерфейс показывает плашку «данные устарели». Снимка нет вовсе — тоже true. */
  stale: boolean;
  /** Сводка пульта и тревоги: состояние Telegram-бота для подсказки в интерфейсе. */
  notify: { configured: boolean; lastError: string | null; lastSentAt: Iso | null };
}
