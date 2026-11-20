#!/usr/bin/env node
import './shared/preload.mjs';
/**
 * Точка входа MSB — открытое ядро после shared profile preload → src/main.mjs.
 * Навигация: [Ядро](./OPEN-CORE.md), [main](./src/main.mjs).
 * Закрытый бандл снят; откат выпуска восстанавливает предыдущий код из release backup.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { main } = await import(pathToFileURL(path.join(__dirname, 'src', 'main.mjs')).href);
await main();
