/** Реестр CLI-провайдеров поверх Claude Code (без OpenClaw). */

export const PROVIDERS = Object.freeze([
  {
    id: 'claude',
    title: 'Claude Code',
    envKey: 'CLAUDE_CODE_OAUTH_TOKEN',
    /** Claude уже настраивается штатным меню бота. */
    authViaStock: true,
    hint: 'Токен из `claude setup-token` (подписка Max).',
    icon: '👾',
  },
  {
    id: 'cursor',
    title: 'Cursor',
    envKey: 'CURSOR_API_KEY',
    authViaStock: false,
    hint: 'Ключ из Cursor Dashboard → API Keys. Если CLI нет — бот поставит `agent` сам.',
    bin: 'agent',
    icon: '🖱',
  },
  {
    id: 'codex',
    title: 'Codex',
    envKey: 'CODEX_ACCESS_TOKEN',
    altEnvKeys: ['OPENAI_API_KEY'],
    authViaStock: false,
    /** Основной вход — ChatGPT в ~/.codex/auth.json; секрет в Telegram не просим. */
    authViaNative: true,
    hint:
      'Штатный вход ChatGPT (`codex login` / device code). Токены остаются в ~/.codex/auth.json, в .env бота не копируются. CLI ставится сам (закреплена 0.166.0).',
    bin: 'codex',
    icon: '🧠',
  },
  {
    id: 'qwen',
    title: 'Qwen',
    envKey: 'QWEN_API_KEY',
    altEnvKeys: ['DASHSCOPE_API_KEY'],
    authViaStock: false,
    hint: 'Ключ Token Plan (`sk-sp-…`) или DashScope (`sk-…`). CLI и ~/.qwen/settings.json настраиваются сами.',
    bin: 'qwen',
    icon: '🐉',
  },
]);

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export function isProviderId(id) {
  return PROVIDERS.some((p) => p.id === id);
}

export const DEFAULT_PROVIDER = 'claude';

export function providerButtonLabel(p, { active = false, configured = false } = {}) {
  const missing = p.authViaNative ? ' · нет входа' : ' · нет ключа';
  const mark = active ? ' ✓' : configured ? '' : missing;
  return `${p.icon} ${p.title}${mark}`;
}
