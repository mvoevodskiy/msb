// Запуск веб-сервиса Пульта:
//   node --disable-warning=ExperimentalWarning src/server/main.ts
// Настройки — переменные окружения (config.ts). Ошибка настроек или старта — текст по-русски и код выхода 1.
// SIGTERM/SIGINT — корректная остановка: сервер, таймеры, база, pid-файл.

import { acquirePidFile, releasePidFile } from './backup.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { stdoutLog as log } from './log.ts';
import { startService, type Service } from './service.ts';

let cfg: Config;
try {
  cfg = loadConfig();
} catch (e) {
  process.stderr.write(`Пульт не запущен: ${e instanceof ConfigError ? e.message : (e as Error).message}\n`);
  process.exit(1);
}

try {
  acquirePidFile(cfg.dataDir);
} catch (e) {
  process.stderr.write(`Пульт не запущен: ${(e as Error).message}\n`);
  process.exit(1);
}

let service: Service;
try {
  service = await startService(cfg, { log });
} catch (e) {
  releasePidFile(cfg.dataDir);
  process.stderr.write(`Пульт не запущен: ${(e as Error).message}\n`);
  process.exit(1);
}

log(`Пульт запущен: http://${cfg.host}:${service.port}, данные ${cfg.dataDir}, Telegram ${cfg.tg ? 'настроен' : 'не настроен (тревоги и сводка не отправляются)'}`);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`остановка по ${signal}`);
  try {
    await service.close();
  } catch (e) {
    log(`ошибка при остановке: ${(e as Error).message}`);
  }
  releasePidFile(cfg.dataDir);
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
