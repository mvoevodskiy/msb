#!/usr/bin/env node
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/store/auth.mjs';
import { createReleaseStore } from '../src/store/releases.mjs';
import { createIntentStore } from '../src/store/intents.mjs';
import { createClientStore } from '../src/store/clients.mjs';
import { createSecretBox } from '../src/store/secrets.mjs';
import { createSshWorker } from '../src/ssh/worker.mjs';
import { createServer } from '../src/api/server.mjs';
import { createInstallerBot } from '../src/bot/app.mjs';
import { createAccess } from '../src/portal/access.mjs';
import { openPortal } from '../src/portal/db.mjs';
import { createSqlStore } from '../src/portal/sql-store.mjs';
import { createTicketService } from '../src/portal/ticket-service.mjs';
import { createSupportBot } from '../src/bot/support.mjs';
import { ensureDir } from '../src/util.mjs';

const config = loadConfig();
await ensureDir(config.dataDir);

const auth = createAuthStore(config.dataDir);
const releases = createReleaseStore(config.dataDir);
const intents = createIntentStore(config.dataDir);
const clients = createClientStore(config.dataDir);
const secretBox = createSecretBox();
await auth.init();
await releases.init();
await intents.init();
await clients.init();

const worker = createSshWorker({ config, auth, releases, intents, clients, secretBox });
await worker.start();

const portal = await openPortal(config.databaseUrl);
const access = createAccess({
  policy: config.accessPolicy,
  findGrant: (installationId, capability) => portal.findGrant(installationId, capability),
});
const tickets = portal.enabled ? createTicketService(createSqlStore(portal)) : null;

const ctx = { config, auth, releases, intents, worker, clients, secretBox, portal, access, tickets };
const botApp = createInstallerBot(ctx);
if (botApp) ctx.botHandleUpdate = botApp.handleUpdate;
const supportBot = createSupportBot(ctx);
if (supportBot) {
  ctx.supportHandleUpdate = supportBot.handleUpdate;
  if (tickets) setInterval(() => { tickets.deliverNext((row) => supportBot.send(row)).catch(() => {}); }, 1000);
}

const server = createServer(ctx);
server.listen(config.port, '0.0.0.0', () => {
  console.log(`[msb-updates] http://0.0.0.0:${config.port} data=${config.dataDir}`);
  console.log(`[portal] policy=${config.accessPolicy} db=${portal.enabled ? 'on' : 'off'} updates=${config.updatesBaseUrl ? 'set' : 'unset'}`);
  console.log(`[msb-updates] public key:\n${worker.getPublicKey()}`);
});

const starts = [];
if (botApp) starts.push(botApp.start());
if (supportBot) starts.push(supportBot.start());
if (starts.length) await Promise.all(starts);
