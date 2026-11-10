import profile from '../shared/profile.cjs';
import { VISIBLE_PERMISSION_MODES } from '../shared/permission-modes.mjs';
import os from 'node:os';
import { PROVIDERS, getProvider, providerButtonLabel } from './providers.mjs';
import { configuredMap } from './env.mjs';
import { loadStore } from './store.mjs';
import {
  listModelsForProvider,
  resolveDisplayedModel,
  modelLabel,
  providerTitle,
} from './models-catalog.mjs';
import { readCodexProfileConfig, resolveSelectedCodexProfileDir } from '../shared/codex-profile.mjs';
import { readBotState } from './paths.mjs';

/** Из «🔌 Подключение» всегда назад в настройки, не в «Агент → Модель». */
const BACK = 'menu:settings';

const PERM_LABELS = {
  auto: 'без спроса',
  smart: 'auto',
  control: 'с подтверждением',
  plan: 'сначала план',
};

const EFFORT_LABELS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function btn(text, callback_data) {
  return { text, callback_data };
}

function keyboard(rows) {
  return { inline_keyboard: rows };
}

export { writeBotPermissionMode } from './integration/actions.mjs';

async function currentPreferences(providerId, store, env, home, state) {
  const profileDir = providerId === 'codex'
    ? await resolveSelectedCodexProfileDir(state ?? await readBotState(env, home), env, home).catch(() => null)
    : null;
  const native = profileDir ? await readCodexProfileConfig(profileDir).catch(() => null) : null;
  const savedEffort = store.efforts?.[providerId];
  const effortId = (typeof savedEffort === 'string' ? savedEffort.trim() : '') || native?.modelReasoningEffort || null;
  return { profileDir, modelId: resolveDisplayedModel(providerId, store.models?.[providerId], native?.model), effortId };
}

export function providerSupportsEffort(providerId) {
  return providerId === 'codex';
}

export async function buildConnMenu(env = process.env, home) {
  const store = await loadStore(env, home);
  const configured = await configuredMap(env, home);
  const active = getProvider(store.active) || PROVIDERS[0];
  const state = await readBotState(env, home);
  const engine = state?.engine === 'oc' ? 'OpenClaw' : active.title;

  const lines = [
    '<b>🔌 Подключение</b>',
    '',
    `Сейчас отвечает: <b>${esc(engine)}</b>.`,
    '',
    'Выбери подключение или настрой авторизацию ниже.',
    'Cursor/Qwen — ключ в .env; Codex — ChatGPT login в ~/.codex (без секрета в Telegram).',
    '',
    'Память и файлы общие; при возврате к подключению продолжается его прежняя беседа.',
    '⠀',
  ];

  const rows = [];

  // Штатное меню бандла — callback_data без префикса ext:, уходит в index.js.
  rows.push([btn('—— Штатные ——', 'ext:conn:noop')]);
  rows.push([
    btn('👾 Claude · токен', 'settings:auth:switch-sub'),
    btn('🌐 OpenRouter', 'settings:auth:openrouter'),
  ]);
  rows.push([
    btn('🦞 OpenClaw', 'settings:engine:set:oc'),
    btn('👾 Движок Claude', 'settings:engine:set:cc'),
  ]);
  rows.push([btn('❓ Штатная справка', 'settings:auth:help')]);

  rows.push([btn('—— Обвязка (CLI) ——', 'ext:conn:noop')]);
  for (const p of PROVIDERS) {
    if (p.id === 'claude') {
      // Claude уже в штатном блоке; в обвязке — только «сделать активным CLI-каналом».
      const isActive = store.active === 'claude';
      rows.push([
        btn(isActive ? '👾 Claude CLI ✓' : '👾 Claude CLI', 'ext:conn:set:claude'),
      ]);
      continue;
    }
    const isActive = p.id === store.active;
    const has = !!configured[p.id];
    const row = [
      btn(providerButtonLabel(p, { active: isActive, configured: has }), `ext:conn:set:${p.id}`),
    ];
    if (p.authViaNative) {
      row.push(btn('🔐 Вход', `ext:auth:${p.id}`));
    } else {
      row.push(btn(has ? '🔑 Новый ключ' : '🔑 Ключ', `ext:auth:${p.id}`));
    }
    rows.push(row);
  }
  rows.push([btn('« Назад', BACK)]);

  return { text: lines.join('\n'), keyboard: keyboard(rows), active: store.active, configured };
}

export function authPrompt(providerId) {
  const p = getProvider(providerId);
  if (!p) return null;
  if (p.authViaNative) {
    return {
      text:
        `${p.icon} <b>${esc(p.title)} · вход</b>\n\n` +
        `Секрет в Telegram не присылай.\n` +
        `Бот поставит CLI (если нужно) и запустит штатный ChatGPT login.\n\n` +
        `${esc(p.hint)}\n\n` +
        'Отмена: « Назад.',
      keyboard: keyboard([[btn('« Назад', 'settings:auth')]]),
      nativeLogin: true,
    };
  }
  return {
    text:
      `${p.icon} <b>${esc(p.title)} · ключ</b>\n\n` +
      `Пришли ключ одним сообщением. Я сразу удалю его из чата и сохраню в .env бота.\n\n` +
      `${esc(p.hint)}\n\n` +
      'Отмена: « Назад.',
    keyboard: keyboard([[btn('« Назад', 'settings:auth')]]),
  };
}

export function switchedText(providerId) {
  const p = getProvider(providerId);
  return `✔ Агент теперь на ${p ? `${p.icon} ${p.title}` : providerId}.`;
}

export function savedKeyText(providerId) {
  const p = getProvider(providerId);
  return `✔ Ключ ${p ? p.title : providerId} сохранён. Можно выбрать его в «🔌 Подключение».`;
}

export function codexLoginGuide({ url, code } = {}) {
  const lines = [
    '🧠 <b>Codex · вход ChatGPT</b>',
    '',
    'Открой ссылку на устройстве с браузером и подтверди вход владельцем.',
  ];
  if (url) lines.push('', `Ссылка: ${esc(url)}`);
  if (code) lines.push(`Код: <code>${esc(code)}</code>`);
  if (!url && !code) {
    lines.push(
      '',
      'Если ссылка не пришла — на сервере пользователя бота выполни <code>codex login --device-auth</code> или <code>codex login</code>.',
      'После появления ~/.codex/auth.json вернись в «🔌 Подключение» и выбери Codex.',
    );
  } else {
    lines.push('', 'Жду подтверждения входа… Движок переключу только после успешной авторизации.');
  }
  return lines.join('\n');
}

/**
 * Экран «🧠 Модель» для активного Cursor/Codex/Qwen — без текстов про Claude.
 */
export async function buildModelMenu(env = process.env, home) {
  const store = await loadStore(env, home);
  const providerId = store.active || 'claude';
  const p = getProvider(providerId);
  if (!p || p.id === 'claude') return null;

  const { modelId: current, profileDir } = await currentPreferences(providerId, store, env, home);
  const models = await listModelsForProvider(providerId, env, home, profileDir);
  const title = providerTitle(providerId);

  const lines = [
    `<b>🧠 Модель</b> · ${esc(title)}`,
    '',
    `Сейчас отвечает <b>${esc(title)}</b>, модель: <b>${esc(modelLabel(providerId, current) || current || '—')}</b>.`,
    '',
    'Выбери модель этого провайдера. Список Claude сюда не относится.',
    '',
    providerId === 'codex'
      ? '<i>Смена модели сохраняет текущую сессию.</i>'
      : '<i>Смена модели начнёт новую беседу у CLI-провайдера.</i>',
  ];

  const rows = [];
  for (const m of models) {
    const mark = m.id === current ? ' ✓' : '';
    rows.push([btn(`${m.label}${mark}`, `ext:model:set:${m.id}`)]);
  }
  if (!models.length) {
    lines.push('', 'Список моделей пуст — проверь CLI провайдера.');
  }
  rows.push([btn('« Назад', 'menu:agent')]);

  return {
    text: lines.join('\n'),
    keyboard: keyboard(rows),
    providerId,
    current,
    models,
  };
}

export function modelSwitchedText(providerId, modelId) {
  const title = providerTitle(providerId);
  return `✔ ${title}: модель <b>${esc(modelLabel(providerId, modelId) || modelId)}</b>.`;
}

/**
 * Экран «🧠 Агент» для активного Cursor/Codex/Qwen — провайдер и его модель, не Claude.
 */
export async function buildAgentMenu(env = process.env, home = env.HOME || os.homedir(), notice = '') {
  const store = await loadStore(env, home);
  const providerId = store.active || 'claude';
  const p = getProvider(providerId);
  if (!p || p.id === 'claude') return null;

  const state = await readBotState(env, home);
  const title = providerTitle(providerId);
  const { modelId, effortId } = await currentPreferences(providerId, store, env, home, state);
  const model = modelLabel(providerId, modelId) || modelId || '—';
  const perm = providerId === 'codex' ? 'полный доступ, без подтверждений' : PERM_LABELS[state.permissionMode] || PERM_LABELS.auto;

  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(
    `<b>🧠 Агент</b> · ${esc(title)}`,
    '',
    `Провайдер: <b>${esc(title)}</b>`,
    `Модель: <b>${esc(model)}</b>`,
  );
  if (providerSupportsEffort(providerId) && effortId) lines.push(`Глубина: <b>${esc(EFFORT_LABELS[effortId] || effortId)}</b>`);
  lines.push(`Режим: <b>${esc(perm)}</b>`, `Подключение: <b>${esc(title)}</b>`, '⠀');

  const rows = [];
  if (providerSupportsEffort(providerId)) {
    rows.push([
      btn('🧠 Модель', 'settings:model'),
      btn('💭 Глубина', 'settings:effort'),
    ]);
    rows.push([
      btn('🔐 Режим', 'settings:permmode'),
      btn('🔌 Подключение', 'settings:conn'),
    ]);
  } else {
    rows.push([
      btn('🧠 Модель', 'settings:model'),
      btn('🔐 Режим', 'settings:permmode'),
    ]);
    rows.push([btn('🔌 Подключение', 'settings:conn')]);
  }
  rows.push([btn('« Назад', 'menu:back')]);

  return {
    text: lines.join('\n'),
    keyboard: keyboard(rows),
    providerId,
    modelId,
  };
}

export async function buildEffortMenu(env = process.env, home = env.HOME || os.homedir()) {
  const store = await loadStore(env, home);
  const providerId = store.active || 'claude';
  if (!providerSupportsEffort(providerId)) {
    const title = providerTitle(providerId);
    return {
      text:
        `<b>💭 Глубина мыслей</b> · ${esc(title)}\n\n` +
        `У ${esc(title)} глубина здесь не настраивается — она задаётся самой моделью/CLI.\n\n` +
        'Выбери модель в «🧠 Модель».',
      keyboard: keyboard([
        [btn('🧠 Модель', 'settings:model')],
        [btn('« Назад', 'menu:agent')],
      ]),
      providerId,
    };
  }

  const title = providerTitle(providerId);
  const { modelId, effortId: current } = await currentPreferences(providerId, store, env, home);
  const levels = [
    { id: 'low', desc: 'быстро, минимум раздумий' },
    { id: 'medium', desc: 'обычная глубина' },
    { id: 'high', desc: 'углублённо' },
    { id: 'xhigh', desc: 'глубже, для кода и сложных задач' },
    { id: 'max', desc: 'максимальная глубина' },
  ];

  const lines = [
    `<b>💭 Глубина мыслей</b> · ${esc(title)}`,
    '',
    `Провайдер: <b>${esc(title)}</b>`,
    `Модель: <b>${esc(modelLabel(providerId, modelId) || modelId || '—')}</b>`,
    '',
    'Насколько глубоко Codex обдумывает ответ (`model_reasoning_effort`).',
    '',
    ...levels.map((z) => `<b>${z.id}</b>: ${z.desc}`),
    '',
    `<b>Сейчас:</b> ${esc(current || 'по умолчанию CLI')}`,
  ];

  const row = [];
  const rows = [];
  for (const z of levels) {
    row.push(btn(`${z.id}${z.id === current ? ' ✓' : ''}`, `ext:effort:set:${z.id}`));
    if (row.length === 2) {
      rows.push([...row]);
      row.length = 0;
    }
  }
  if (row.length) rows.push([...row]);
  rows.push([btn('« Назад', 'menu:agent')]);

  return { text: lines.join('\n'), keyboard: keyboard(rows), providerId, current };
}

export async function buildPermModeMenu(env = process.env, home = env.HOME || os.homedir()) {
  const store = await loadStore(env, home);
  const providerId = store.active || 'claude';
  if (!providerId || providerId === 'claude') return null;

  const title = providerTitle(providerId);
  const state = await readBotState(env, home);
  const current = state.permissionMode || 'auto';
  const { modelId } = await currentPreferences(providerId, store, env, home, state);
  const modes = VISIBLE_PERMISSION_MODES;

  const lines = [
    `<b>🔐 Режим работы</b> · ${esc(title)}`,
    '',
    `Провайдер: <b>${esc(title)}</b>`,
    `Модель: <b>${esc(modelLabel(providerId, modelId) || modelId || '—')}</b>`,
    '',
    ...modes.map((m) => `<b>${esc(m.label)}</b>: ${esc(m.desc)}`),
    '',
    `<b>${providerId === 'codex' ? 'Сохранённая настройка' : 'Сейчас'}:</b> ${esc(PERM_LABELS[current] || current)}`,
    ...(providerId === 'codex' ? ['', 'Фактические права Codex: полный доступ, без подтверждений. Эта настройка интерфейса их не меняет.'] : []),
  ];

  const rows = modes.map((m) => [
    btn(`${m.label}${m.id === current ? ' ✓' : ''}`, `ext:permmode:set:${m.id}`),
  ]);
  rows.push([btn('« Назад', 'menu:agent')]);
  return { text: lines.join('\n'), keyboard: keyboard(rows), providerId };
}

/**
 * Экран «Локальный SSH IP» — обход constructor SSH на внешний vps_ip.
 */
export async function buildLocalSshMenu(env = process.env) {
  const { getLocalSshHost } = await import('./local-ssh.mjs');
  const host = getLocalSshHost(env);
  const lines = [
    '<b>🖧 Локальный SSH IP</b>',
    '',
    'Конструктор для списка ботов и SSH-ключей подключается к серверу по <b>внешнему</b> IP из карточки клиента.',
    'Если бот во внутренней сети и :22 снаружи не проброшен — эти экраны падают.',
    '',
    host
      ? `Сейчас локальный адрес: <code>${esc(host)}</code>\nСтатус SSH читается <b>на этой машине</b>, без подключения с хаба.`
      : 'Сейчас не задан — используется только конструктор (внешний IP).',
    '',
    `Укажи IPv4/hostname этой машины в LAN (например <code>${profile.resolveProfile(env).lanExample}</code> или <code>127.0.0.1</code>).`,
    `Переменная: <code>${profile.profileEnvKey('MSB_LOCAL_SSH_HOST', env)}</code> (её же можно задать в «🔑 Переменные окружения»).`,
  ];
  const rows = [[btn(host ? '✏️ Изменить' : '➕ Указать IP', 'ext:ssh:local:edit')]];
  if (host) rows.push([btn('🗑 Сбросить', 'ext:ssh:local:clear')]);
  rows.push([btn('« Назад', 'settings:ssh')]);
  return { text: lines.join('\n'), keyboard: keyboard(rows) };
}

export function localSshPrompt(env = process.env) {
  return {
    text:
      '<b>🖧 Локальный SSH IP</b>\n\n' +
      'Пришли IPv4 или hostname одной строкой.\n' +
      `Примеры: <code>${profile.resolveProfile(env).lanExample}</code>, <code>127.0.0.1</code>\n\n` +
      'После сохранения статус SSH читается локально. Управление ключами и firewall в этом меню пока недоступно.',
    keyboard: keyboard([[btn('✖️ Отмена', 'ext:ssh:local')]]),
  };
}
