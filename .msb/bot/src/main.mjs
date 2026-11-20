/**
 * Владельцем процесса является main(): config → Telegram polling + schedulers;
 * shutdown прекращает приём, дожидается ходов и останавливает heartbeat.
 * Вход: [index.js](../index.js) после [overlay/run](../../../overlay/bot/run.mjs).
 * По задаче: сообщения/команды/кнопки → [createBot](./telegram/bot.mjs);
 * выполнение модели/сессия → [runAgentTurn](./agent/turn.mjs);
 * интервальные задачи и сохранённые таймеры → [autonomy scheduler](./autonomy/scheduler.mjs);
 * источники/дайджест → [monitor scheduler](./monitor/scheduler.mjs);
 * профиль/папки → [paths](./paths.mjs), состояние → [state](./state.mjs);
 * восстановление выбранного проекта перед polling → [projects](./projects/restore.mjs).
 * Проверка exported runtime/shutdown: [profile smoke](../../../tools/release/profile-smoke.mjs),
 * [polling lifecycle](../tests/turn-lifecycle.test.mjs). Контракты — у модулей.
 */
import { assertRuntimeConfig, readConfig } from './config.mjs';
import { startHeartbeat } from './heartbeat.mjs';
import { startScheduler } from './autonomy/scheduler.mjs';
import { startMonitorScheduler } from './monitor/scheduler.mjs';
import { createBot, runPolling } from './telegram/bot.mjs';
import { ensureDir, botRoot, sessionDir, autonomyDir } from './paths.mjs';
import { restoreProjectState } from './projects/restore.mjs';
import { monitorDir } from './monitor/config.mjs';

export async function main() {
  const cfg = readConfig();
  console.error(`[msb/open] boot version=${cfg.version} botId=${cfg.botId}`);
  assertRuntimeConfig(cfg);

  ensureDir(botRoot());
  ensureDir(sessionDir());
  ensureDir(autonomyDir());
  ensureDir(monitorDir());
  await restoreProjectState();

  const heartbeat = startHeartbeat();
  const bot = createBot(cfg);
  const scheduler = startScheduler({
    api: bot.api,
    adminId: cfg.adminId,
    timezone: cfg.timezone,
    scheduledTurns: bot[Symbol.for('msb.scheduledTurns')],
    runCodexPrompt: bot[Symbol.for('msb.savedCodexPrompt')],
    runCursorPrompt: bot[Symbol.for('msb.savedCursorPrompt')],
    readCodexQuota: bot[Symbol.for('msb.createSavedCodexQuotaReader')]?.(),
  });
  const monitor = startMonitorScheduler({
    api: bot.api,
    adminId: cfg.adminId,
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const savedDispatch = scheduler.stop();
    monitor.stop();
    console.error(`[msb/open] ${sig} — shutting down`);
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
    await savedDispatch;
    heartbeat.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runPolling(bot);
}
