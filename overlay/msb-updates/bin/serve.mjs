#!/usr/bin/env node
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/store/auth.mjs';
import { createReleaseStore } from '../src/store/releases.mjs';
import { createIntentStore } from '../src/store/intents.mjs';
import { createSshWorker } from '../src/ssh/worker.mjs';
import { createServer } from '../src/api/server.mjs';
import { createInstallerBot } from '../src/bot/app.mjs';
import { ensureDir } from '../src/util.mjs';

const config = loadConfig();
await ensureDir(config.dataDir);

const auth = createAuthStore(config.dataDir);
const releases = createReleaseStore(config.dataDir);
const intents = createIntentStore(config.dataDir);
await auth.init();
await releases.init();
await intents.init();

const worker = createSshWorker({ config, auth, releases, intents });
await worker.start();

const ctx = { config, auth, releases, intents, worker };
const botApp = createInstallerBot(ctx);
if (botApp) ctx.botHandleUpdate = botApp.handleUpdate;

const server = createServer(ctx);
server.listen(config.port, '0.0.0.0', () => {
  console.log(`[msb-updates] http://0.0.0.0:${config.port} data=${config.dataDir}`);
  console.log(`[msb-updates] public key:\n${worker.getPublicKey()}`);
});

if (botApp) await botApp.start();
