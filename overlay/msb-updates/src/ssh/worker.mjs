import { createHetznerServer, getHetznerServer } from '../hoster/hetzner.mjs';
import { redact } from '../util.mjs';
import { buildAdminBootstrapScript, buildDropAdminKeyScript, nextSetupAction } from './admin-bootstrap.mjs';
import { buildUpdatesUrlScript } from './updates-url.mjs';
import { ensureHubKey } from './keys.mjs';
import { createSshRunner } from './remote.mjs';

export function createSshWorker({ config, intents, clients = null, secretBox = null }) {
  let runner = null;
  let busy = false;
  let pubKey = '';

  async function start() {
    const key = await ensureHubKey(config.dataDir);
    pubKey = key.publicKey;
    runner = createSshRunner({
      privateKeyPath: key.privateKeyPath,
      strictHostKey: config.sshStrictHostKey,
    });
    setInterval(() => { tick().catch(() => {}); }, 5000);
  }

  function getPublicKey() {
    return pubKey;
  }

  async function tick() {
    if (busy || !runner) return;
    const pending = await intents.listPending(5);
    const job = pending.find((i) => i.status === 'queued' || i.status === 'awaiting_ssh');
    if (!job) return;
    if (!job.host && job.type !== 'system_setup') return;
    if (job.status === 'awaiting_ssh') {
      // ждём явного retry/queued от API после ввода host — но если host уже есть, берём в работу
    }
    busy = true;
    try {
      await processIntent(job.id);
    } finally {
      busy = false;
    }
  }

  async function enqueue(intentId) {
    await intents.setStatus(intentId, 'queued');
    // immediate attempt
    setTimeout(() => { tick().catch(() => {}); }, 100);
  }

  async function failSetup(intent, error, secret) {
    const safe = redact(error, [secret].filter(Boolean)).slice(0, 300);
    await intents.setStatus(intent.id, 'failed', { error: safe });
    if (intent.installation_id && clients) {
      await clients.updateInstallation(intent.installation_id, { status: 'failed', error: safe });
    }
  }

  async function writeBotToken(intent, botToken) {
    const user = intent.ssh_user || 'root';
    const command = user === 'root'
      ? 'umask 077; cat > /root/bot-default.env'
      : 'umask 077; sudo -n tee /root/bot-default.env >/dev/null';
    const run = await runner.run(intent.host, {
      port: intent.port,
      user,
      command,
      stdin: `BOT_TOKEN=${botToken}\n`,
      timeoutMs: 30000,
    });
    if (!run.ok) return false;
    const chmod = user === 'root'
      ? 'chmod 600 /root/bot-default.env'
      : 'sudo -n chmod 600 /root/bot-default.env';
    const mode = await runner.run(intent.host, {
      port: intent.port,
      user,
      command: chmod,
      timeoutMs: 15000,
    });
    return mode.ok;
  }

  async function setupSystem(intent) {
    if (intent.migrate_from === 'iia') {
      await failSetup(intent, 'iia_removed');
      return;
    }
    const action = nextSetupAction(intent);
    if (action === 'need_host') {
      await failSetup(intent, 'need_host');
      return;
    }
    let platformToken = null;
    if (action === 'create' || action === 'refresh') {
      const account = clients
        ? await clients.getPlatformAccount(intent.tg_user_id, intent.platform_account_id)
        : null;
      if (!account?.token) {
        await failSetup(intent, 'no_platform_token');
        return;
      }
      if (config.hoster?.provider !== 'hetzner' || account.provider !== 'hetzner') {
        await failSetup(intent, 'unsupported_hoster', account.token);
        return;
      }
      platformToken = account.token;
    }
    try {
      if (action === 'create') {
        const name = `msb-${String(intent.id).replace(/^intent_/, '').slice(0, 12)}`;
        const created = await createHetznerServer({
          token: platformToken,
          name,
          publicKey: pubKey,
          serverType: config.hoster.serverType,
          image: config.hoster.image,
          location: config.hoster.location,
          onServer: async (server) => {
            intent.provider_server_id = server.serverId;
            if (server.ipv4) intent.host = server.ipv4;
            await intents.save(intent);
            if (intent.installation_id && clients) {
              await clients.updateInstallation(intent.installation_id, {
                provider: 'hetzner',
                provider_server_id: server.serverId,
                host: server.ipv4 || null,
                name: server.name,
              });
            }
          },
        });
        intent.host = created.ipv4;
        intent.provider_server_id = created.serverId;
        await intents.save(intent);
      } else if (action === 'refresh') {
        const server = await getHetznerServer({
          token: platformToken,
          serverId: intent.provider_server_id,
        });
        if (!server.ipv4) {
          await intents.setStatus(intent.id, 'queued', { error: 'no_ipv4' });
          return;
        }
        intent.host = server.ipv4;
        await intents.save(intent);
        if (intent.installation_id && clients) {
          await clients.updateInstallation(intent.installation_id, { host: server.ipv4, provider: 'hetzner' });
        }
      }

      if (!intent.host) {
        await failSetup(intent, 'no_host', platformToken);
        return;
      }

      await intents.setStatus(intent.id, 'probing');
      const user = intent.ssh_user || 'root';
      await intents.appendLog(intent.id, `SSH probe ${user}@${intent.host}:${intent.port}`);
      const probe = await runner.probe(intent.host, { port: intent.port, user });
      if (!probe.ok || !probe.stdout.includes('MSB_SSH_OK')) {
        await intents.setStatus(intent.id, 'awaiting_ssh', { error: 'ssh_probe_failed' });
        await intents.appendLog(intent.id, 'ssh probe failed');
        return;
      }

      const botToken = secretBox?.peek(intent.installation_id) || null;
      if (botToken) {
        const wrote = await writeBotToken(intent, botToken);
        if (!wrote) {
          await intents.appendLog(intent.id, 'bot token write failed');
          await intents.setStatus(intent.id, 'awaiting_ssh', { error: 'bot_token_write_failed' });
          return;
        }
        secretBox.drop(intent.installation_id);
        await intents.appendLog(intent.id, 'bot token written on server');
      }

      const command = user === 'root' ? 'bash -s' : 'sudo -n bash -s';
      const run = await runner.run(intent.host, {
        port: intent.port,
        user,
        command,
        stdin: buildAdminBootstrapScript(pubKey),
        timeoutMs: 120000,
      });
      if (!run.ok || !(run.stdout || '').includes('MSB_ADMIN_READY')) {
        await intents.appendLog(intent.id, redact(run.stderr || run.stdout || 'admin bootstrap failed', [platformToken]).slice(0, 500));
        await failSetup(intent, 'admin_bootstrap_failed', platformToken);
        return;
      }
      if (!config.updatesBaseUrl) {
        await intents.appendLog(intent.id, 'updates url is not configured');
        await failSetup(intent, 'updates_url_missing', platformToken);
        return;
      }
      const urlRun = await runner.run(intent.host, {
        port: intent.port,
        user,
        command,
        stdin: buildUpdatesUrlScript(config.updatesBaseUrl),
        timeoutMs: 30000,
      });
      if (!urlRun.ok || !(urlRun.stdout || '').includes('MSB_UPDATES_URL_SET')) {
        await intents.appendLog(intent.id, 'updates url was not written');
        await failSetup(intent, 'updates_url_failed', platformToken);
        return;
      }
      if (intent.installation_id && clients) {
        await clients.updateInstallation(intent.installation_id, {
          host: intent.host,
          provider_server_id: intent.provider_server_id || null,
          status: 'ready',
          error: null,
          admin_key_installed: true,
        });
      }
      await intents.setStatus(intent.id, 'done', { error: null, host: intent.host });
      await intents.appendLog(intent.id, `msb-admin ready @ ${intent.host}`);
    } catch (err) {
      await failSetup(intent, err.message || 'setup_failed', platformToken);
    }
  }

  async function dropAdminKey(installationId) {
    if (!clients || !runner) return { ok: false, error: 'not_ready' };
    const rec = await clients.getInstallation(installationId);
    if (!rec?.host) return { ok: false, error: 'no_host' };
    const run = await runner.run(rec.host, {
      port: rec.port || 22,
      user: 'msb-admin',
      command: 'bash -s',
      stdin: buildDropAdminKeyScript(pubKey),
      timeoutMs: 30000,
    });
    if (!run.ok || !(run.stdout || '').includes('MSB_ADMIN_KEY_REMOVED')) {
      return { ok: false, error: 'drop_failed' };
    }
    await clients.updateInstallation(rec.id, { admin_key_installed: false });
    return { ok: true };
  }

  async function processIntent(intentId) {
    const intent = await intents.get(intentId);
    if (!intent) return;
    if (intent.type === 'system_setup') {
      await setupSystem(intent);
      return;
    }
    if (intent.type === 'ext_overlay' || intent.type === 'empty_bot') {
      await intents.setStatus(intent.id, 'failed', { error: 'overlay_retired' });
      await intents.appendLog(intent.id, 'установка обвязки на существующий бот снята');
      return;
    }
    await intents.setStatus(intent.id, 'failed', { error: 'unsupported_install' });
  }

  return { start, enqueue, processIntent, getPublicKey, tick, dropAdminKey };
}
