import fs from 'node:fs/promises';
import path from 'node:path';
import { botRoot } from '../paths.mjs';
import { readCodexProfileConfig, resolveSelectedCodexProfileDir } from '../../shared/codex-profile.mjs';
import { readClaudeVersion } from './claude-version.mjs';
import { modelShortLabel } from './models.mjs';
import { effectiveClaudeEffort } from './effort.mjs';
import { resolveModel } from '../state.mjs';

const TITLES = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  qwen: 'Qwen',
  openai: 'OpenAI-совместимый',
};

/**
 * [Agent screen](../telegram/screens/agent.mjs) → read selected provider/model/effort.
 * Claude effective depth → [effort policy](./effort.mjs); external choices stay in
 * provider store/native config. No writes. Checks: [Claude depth](../../tests/claude-effort.test.mjs).
 */
export async function agentDisplay(state, env = process.env) {
  if (state.engine === 'oc') return { engine: 'OpenClaw', model: '—', effort: null };
  let store = {};
  try { store = JSON.parse(await fs.readFile(path.join(botRoot(env), 'ext-providers.json'), 'utf8')); }
  catch { /* standalone core has no extension */ }
  const provider = env.JARVIS_CC_ONLY === '1' ? 'claude' : store.active || state.extAuthBypass || 'claude';
  if (provider === 'claude') {
    const model = resolveModel(state), version = await readClaudeVersion(env);
    return { engine: 'Claude Code', model, label: modelShortLabel(model,version),
      effort: effectiveClaudeEffort(model,state.ccEffort || state.effort,version) };
  }
  let native;
  if (provider === 'codex') {
    try {
      const directory = await resolveSelectedCodexProfileDir(state, env);
      native = await readCodexProfileConfig(directory);
    } catch { /* Native config is optional. */ }
  }
  const previous = state.lastCcUsage?.sessionId === state.ccSessionId ? state.lastCcUsage : null;
  return {
    engine: TITLES[provider] || provider,
    model: store.models?.[provider] || native?.model || previous?.model || '—',
    effort: store.efforts?.[provider] || native?.modelReasoningEffort || null,
  };
}
