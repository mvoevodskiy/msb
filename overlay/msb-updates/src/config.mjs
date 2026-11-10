import path from 'node:path';
import os from 'node:os';

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

export function loadConfig(envMap = process.env) {
  const dataDir = envMap.MSB_UPDATES_DATA || path.join(os.homedir(), 'msb-updates-data');
  const port = Number(envMap.PORT || envMap.MSB_UPDATES_PORT || 8787);
  const baseUrl = (envMap.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const adminIds = String(envMap.INSTALLER_ADMIN_TG_IDS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  const egressIps = String(envMap.HUB_EGRESS_IPS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    dataDir,
    port,
    baseUrl,
    adminIds,
    egressIps,
    botToken: envMap.INSTALLER_BOT_TOKEN || '',
    webhookSecret: envMap.TELEGRAM_WEBHOOK_SECRET || '',
    botMode: envMap.BOT_MODE || (envMap.PUBLIC_BASE_URL ? 'webhook' : 'polling'),
    defaultSshUser: envMap.MSB_SSH_USER || 'client',
    sshStrictHostKey: envMap.MSB_SSH_STRICT !== '0',
  };
}
