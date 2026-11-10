import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { id, nowIso } from '../util.mjs';
import { ensureHubKey } from './keys.mjs';
import { buildRemoteExtInstallScript, createSshRunner } from './remote.mjs';

export function createSshWorker({ config, auth, releases, intents }) {
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
    if (!job || !job.host) return;
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

  async function processIntent(intentId) {
    const intent = await intents.get(intentId);
    if (!intent?.host) return;

    await intents.setStatus(intentId, 'probing');
    await intents.appendLog(intentId, `SSH probe ${intent.ssh_user}@${intent.host}:${intent.port}`);

    const probe = await runner.probe(intent.host, {
      port: intent.port,
      user: intent.ssh_user || config.defaultSshUser,
    });
    if (!probe.ok || !probe.stdout.includes('MSB_SSH_OK')) {
      await intents.setStatus(intentId, 'awaiting_ssh', {
        error: 'ssh_probe_failed',
        result: { stderr: probe.stderr, stdout: probe.stdout },
      });
      await intents.appendLog(intentId, `probe failed: ${(probe.stderr || probe.stdout || '').slice(0, 500)}`);
      return;
    }
    await intents.appendLog(intentId, probe.stdout.trim().split('\n').join(' | '));

    if (intent.type === 'ext_overlay' || intent.type === 'empty_bot') {
      await intents.setStatus(intentId, 'applying');
      await applyExtOverlay(intent, probe);
    }
  }

  async function detectCoreVersion(intent) {
    const r = await runner.run(intent.host, {
      port: intent.port,
      user: intent.ssh_user,
      command: `python3 - <<'PY'
import json,hashlib,pathlib
live=pathlib.Path.home()/".msb"
core=""
st=live/".puller-state.json"
if st.exists():
  try: core=json.loads(st.read_text()).get("applied_platform_version") or ""
  except: pass
fp=""
idx=live/"bot"/"index.js"
if idx.exists(): fp=hashlib.sha256(idx.read_bytes()).hexdigest()
print(core)
print(fp)
print("HAS_INDEX" if idx.exists() else "NO_INDEX")
PY`,
    });
    if (!r.ok) return { core: null, fingerprint: null, hasIndex: false, err: r.stderr };
    const [core, fp, flag] = r.stdout.trim().split('\n');
    return { core: core || null, fingerprint: fp || null, hasIndex: flag === 'HAS_INDEX', err: null };
  }

  async function applyExtOverlay(intent) {
    const detected = await detectCoreVersion(intent);
    if (detected.err) {
      await intents.setStatus(intent.id, 'failed', { error: 'detect_core_failed', result: detected });
      return;
    }
    if (!detected.hasIndex && intent.type === 'ext_overlay') {
      await intents.setStatus(intent.id, 'failed', { error: 'no_core_bundle', result: detected });
      await intents.appendLog(intent.id, 'на сервере нет bot/index.js — это не существующий бот');
      return;
    }

    let coreVersion = detected.core || (detected.fingerprint ? `sha256:${detected.fingerprint}` : null);
    await intents.appendLog(intent.id, `core=${coreVersion || 'unknown'}`);

    let manifest = null;
    if (coreVersion && !String(coreVersion).startsWith('sha256:')) {
      manifest = await releases.compatibleExt(coreVersion);
    }
    if (!manifest) {
      // fallback: latest ext if no platform version string
      const latest = await releases.latest('ext');
      if (latest && (!coreVersion || String(coreVersion).startsWith('sha256:'))) {
        manifest = latest;
        await intents.appendLog(intent.id, `нет platform_version — берём latest ext ${latest.version}`);
      }
    }
    if (!manifest) {
      await intents.setStatus(intent.id, 'failed', {
        error: 'no_compatible_ext',
        core_version: coreVersion,
      });
      await intents.appendLog(intent.id, 'нет совместимого релиза обвязки для этого ядра');
      return;
    }

    const filesB64 = [];
    for (const f of manifest.files) {
      const blobFile = releases.openBlob(f.sha256);
      if (!blobFile) throw new Error(`missing blob ${f.sha256}`);
      const buf = await fsp.readFile(blobFile);
      filesB64.push({
        path: f.path,
        sha256: f.sha256,
        mode: f.mode || '644',
        b64: buf.toString('base64'),
      });
    }

    const boxId = id('box');
    const { token } = await auth.issueToken({
      tgUserId: intent.tg_user_id,
      kind: 'install_box',
      scopes: ['core:read', 'ext:read'],
      boxId,
    });
    await auth.bindBox(intent.tg_user_id, boxId);

    const script = buildRemoteExtInstallScript({
      apiBase: config.baseUrl,
      installToken: token,
      manifestJson: manifest,
      filesBase64: filesB64,
    });

    // upload script and run
    const remoteScript = `/tmp/msb-ext-install-${intent.id}.sh`;
    const up = await runner.uploadBytes(
      intent.host,
      { port: intent.port, user: intent.ssh_user },
      remoteScript,
      script,
    );
    if (!up.ok) {
      await intents.setStatus(intent.id, 'failed', { error: 'upload_failed', result: up });
      return;
    }

    const run = await runner.run(intent.host, {
      port: intent.port,
      user: intent.ssh_user,
      command: `chmod +x ${remoteScript} && bash ${remoteScript}; rm -f ${remoteScript}`,
      timeoutMs: 300000,
    });
    await intents.appendLog(intent.id, (run.stdout || '').slice(-1500));
    if (run.stderr) await intents.appendLog(intent.id, `stderr: ${(run.stderr || '').slice(0, 800)}`);
    if (!run.ok || !(run.stdout || '').includes('DONE')) {
      const errLine = (run.stderr || run.stdout || 'remote failed').trim().split('\n').slice(-3).join(' | ');
      await intents.appendLog(intent.id, `apply failed: ${errLine.slice(0, 500)}`);
      await intents.setStatus(intent.id, 'failed', {
        error: 'remote_apply_failed',
        result: { stderr: run.stderr, stdout: run.stdout },
      });
      return;
    }

    if (intent.type === 'empty_bot') {
      // если ядра нет — пробуем поставить latest core перед ext (уже поставили ext); отдельно догрузим core
      if (!detected.hasIndex) {
        await intents.appendLog(intent.id, 'empty_bot: ядра нет, ставлю latest core');
        const core = await releases.latest('core');
        if (core) {
          await remoteApplyChannel(intent, core);
        } else {
          await intents.appendLog(intent.id, 'релиза core нет — только обвязка');
        }
      }
    }

    await intents.setStatus(intent.id, 'done', {
      error: null,
      box_id: boxId,
      core_version: coreVersion,
      ext_version: manifest.version,
      result: { finished_at: nowIso(), dropin: (run.stdout || '').includes('DROPIN_OK') },
    });
    await intents.appendLog(intent.id, `готово ext=${manifest.version}`);
  }

  async function remoteApplyChannel(intent, manifest) {
    const filesB64 = [];
    for (const f of manifest.files) {
      const blobFile = releases.openBlob(f.sha256);
      const buf = await fsp.readFile(blobFile);
      filesB64.push({ path: f.path, sha256: f.sha256, mode: f.mode || '644', b64: buf.toString('base64') });
    }
    const script = buildRemoteExtInstallScript({
      apiBase: config.baseUrl,
      installToken: 'unused',
      manifestJson: manifest,
      filesBase64: filesB64,
    });
    // reuse installer without rewriting token meaningfully — still ok for core files
    const remoteScript = `/tmp/msb-core-install-${intent.id}.sh`;
    await runner.uploadBytes(intent.host, { port: intent.port, user: intent.ssh_user }, remoteScript, script);
    await runner.run(intent.host, {
      port: intent.port,
      user: intent.ssh_user,
      command: `chmod +x ${remoteScript} && bash ${remoteScript}; rm -f ${remoteScript}`,
      timeoutMs: 300000,
    });
  }

  return { start, enqueue, processIntent, getPublicKey, tick };
}
