import path from 'node:path';
import os from 'node:os';

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

export function loadConfig(envMap = process.env) {
  const dataDir = envMap.MSB_UPDATES_DATA || path.join(os.homedir(), 'msb-updates-data');
  const port = Number(envMap.PORT || envMap.MSB_UPDATES_PORT || 8787);
  const baseUrl = cleanUrl(envMap.PUBLIC_BASE_URL) || `http://127.0.0.1:${port}`;
  const updatesBaseUrl = cleanUrl(envMap.UPDATES_BASE_URL);
  const accessPolicy = String(envMap.ACCESS_POLICY || 'open').trim() || 'open';
  if (accessPolicy !== 'open' && accessPolicy !== 'restricted') {
    throw new Error(`ACCESS_POLICY must be open or restricted, got ${accessPolicy}`);
  }
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
    updatesBaseUrl,
    accessPolicy,
    databaseUrl: String(envMap.PORTAL_DATABASE_URL || '').trim(),
    crmPassword: String(envMap.CRM_PASSWORD || ''),
    adminIds,
    egressIps,
    botToken: envMap.INSTALLER_BOT_TOKEN || '',
    webhookSecret: envMap.TELEGRAM_WEBHOOK_SECRET || '',
    supportBotToken: envMap.SUPPORT_BOT_TOKEN || '',
    supportWebhookSecret: envMap.SUPPORT_WEBHOOK_SECRET || '',
    botMode: envMap.BOT_MODE || (envMap.PUBLIC_BASE_URL ? 'webhook' : 'polling'),
    defaultSshUser: envMap.MSB_SSH_USER || 'client',
    sshStrictHostKey: envMap.MSB_SSH_STRICT !== '0',
    hoster: {
      provider: envMap.HOSTER_PROVIDER || 'hetzner',
      serverType: envMap.HOSTER_SERVER_TYPE || 'cpx21',
      image: envMap.HOSTER_IMAGE || 'ubuntu-24.04',
      location: envMap.HOSTER_LOCATION || 'fsn1',
    },
  };
}

export function isInstallerAdmin(adminIds, userId) {
  const id = Number(userId);
  if (!Array.isArray(adminIds) || !adminIds.length || !Number.isFinite(id)) return false;
  return adminIds.includes(id);
}
