import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureDir } from '../util.mjs';

const execFileAsync = promisify(execFile);

export function createSshRunner({ privateKeyPath, strictHostKey = true }) {
  function baseArgs(host, port, user) {
    const args = [
      '-i', privateKeyPath,
      '-p', String(port || 22),
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=15',
      '-o', strictHostKey ? 'StrictHostKeyChecking=accept-new' : 'StrictHostKeyChecking=no',
      `${user}@${host}`,
    ];
    return args;
  }

  async function run(host, { port = 22, user = 'client', command, timeoutMs = 120000 }) {
    const args = [...baseArgs(host, port, user), command];
    try {
      const { stdout, stderr } = await execFileAsync('ssh', args, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LANG: 'C' },
      });
      return { ok: true, stdout: stdout || '', stderr: stderr || '' };
    } catch (err) {
      return {
        ok: false,
        code: err.code || err.status || null,
        stdout: err.stdout?.toString?.() || '',
        stderr: err.stderr?.toString?.() || String(err.message || err),
      };
    }
  }

  async function probe(host, opts = {}) {
    return run(host, { ...opts, command: 'echo MSB_SSH_OK; whoami; hostname; test -d "$HOME/.msb" && echo HAS_IIA || echo NO_IIA' });
  }

  async function uploadBytes(host, opts, remotePath, content) {
    const tmp = path.join(os.tmpdir(), `msb-up-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fsp.writeFile(tmp, content);
    try {
      const args = [
        '-i', privateKeyPath,
        '-P', String(opts.port || 22),
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ConnectTimeout=15',
        tmp,
        `${opts.user || 'client'}@${host}:${remotePath}`,
      ];
      await execFileAsync('scp', args, { timeout: 120000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, stderr: String(err.stderr || err.message || err) };
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  return { run, probe, uploadBytes };
}

/** Собирает remote bootstrap script для установки ext на уже живой бокс. */
export function buildRemoteExtInstallScript({
  apiBase,
  installToken,
  manifestJson,
  filesBase64, // [{path, b64, mode}]
  dropInSrcRel = 'bot/systemd/60-ext-entry.conf',
}) {
  const filesLit = JSON.stringify(filesBase64);
  const manifestLit = JSON.stringify(manifestJson);
  return `#!/usr/bin/env bash
set -euo pipefail
LIVE="\${HOME}/.msb"
mkdir -p "\$LIVE/bot" "\$LIVE/bot/ext" "\$LIVE/bot/systemd" "\$LIVE/updates/rollback"

# прошлые выкладки от msb-admin/root оставляют bot/ext недоступным client —
# чиним владельца до записи (passwordless sudo на штатных боксах).
if sudo -n true 2>/dev/null; then
  sudo -n mkdir -p "\$LIVE/bot/ext" "\$LIVE/bot/systemd"
  sudo -n chown -R "\$(id -u):\$(id -g)" \\
    "\$LIVE/bot/ext" \\
    "\$LIVE/bot/run.mjs" \\
    "\$LIVE/bot/systemd" \\
    "\$LIVE/.msb-updates-staging" 2>/dev/null || true
  echo CHOWN_OK
else
  echo CHOWN_SKIP
fi

python3 - <<'PY'
import base64, json, os, hashlib, pathlib, shutil
live = pathlib.Path(os.path.expanduser("~/.msb"))
manifest = json.loads(${JSON.stringify(manifestLit)})
files = json.loads(${JSON.stringify(filesLit)})
staging = live / ".msb-updates-staging" / ("ext-" + str(os.getpid()))
staging.mkdir(parents=True, exist_ok=True)
rollback = live / "updates" / "rollback" / ("ext-" + manifest["version"])
rollback.mkdir(parents=True, exist_ok=True)

def install_file(src: pathlib.Path, dst: pathlib.Path):
  dst.parent.mkdir(parents=True, exist_ok=True)
  # copy+replace: устойчивее к чужому владельцу на том же FS
  tmp = dst.with_name(dst.name + ".msb-new")
  try:
    if tmp.exists():
      tmp.unlink()
    shutil.copy2(src, tmp)
    os.chmod(tmp, src.stat().st_mode & 0o777)
    os.replace(tmp, dst)
  finally:
    if tmp.exists():
      try: tmp.unlink()
      except OSError: pass

try:
  for f in files:
    rel = f["path"]
    if ".." in rel.split("/"):
      raise SystemExit("bad path " + rel)
    data = base64.b64decode(f["b64"])
    digest = hashlib.sha256(data).hexdigest()
    if digest != f["sha256"]:
      raise SystemExit("hash mismatch " + rel)
    dest = staging / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    mode = int(f.get("mode") or "644", 8)
    dest.chmod(mode)
    live_file = live / rel
    if live_file.exists():
      bak = rollback / rel
      bak.parent.mkdir(parents=True, exist_ok=True)
      shutil.copy2(live_file, bak)
  for f in files:
    rel = f["path"]
    src = staging / rel
    dst = live / rel
    install_file(src, dst)
finally:
  shutil.rmtree(staging, ignore_errors=True)
print("APPLIED", manifest["version"])
# detect core
core = None
st = live / ".puller-state.json"
if st.exists():
  try:
    core = json.loads(st.read_text()).get("applied_platform_version")
  except Exception:
    pass
idx = live / "bot" / "index.js"
fp = None
if idx.exists():
  fp = hashlib.sha256(idx.read_bytes()).hexdigest()
print("CORE", core or "")
print("FINGERPRINT", fp or "")
PY

ENVF="\$LIVE/.env"
touch "\$ENVF"
chmod 600 "\$ENVF"
# upsert MSB_UPDATES_* и снять JARVIS_CC_ONLY (иначе меню только Claude)
python3 - <<'PY'
from pathlib import Path
import os

def upsert_env(path: Path, updates: dict, drop_keys: set):
  text = path.read_text() if path.exists() else ""
  kv = {}
  order = []
  for line in text.splitlines():
    if not line or line.startswith("#") or "=" not in line:
      continue
    k, _, v = line.partition("=")
    if k in drop_keys:
      continue
    if k not in kv:
      order.append(k)
    kv[k] = v
  for k, v in updates.items():
    if k not in kv:
      order.append(k)
    kv[k] = v
  for k in drop_keys:
    kv.pop(k, None)
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text("\\n".join(f"{k}={kv[k]}" for k in order if k in kv) + "\\n")
  try:
    os.chmod(path, 0o600)
  except OSError:
    pass

live = Path.home() / ".msb"
drop = {"JARVIS_CC_ONLY"}
updates = {
  "MSB_UPDATES_URL": ${JSON.stringify(apiBase)},
  "MSB_UPDATES_TOKEN": ${JSON.stringify(installToken)},
  "MSB_UPDATES_AUTO": "0",
}
# глобальный .env
g = live / ".env"
old_auto = None
if g.exists():
  for line in g.read_text().splitlines():
    if line.startswith("MSB_UPDATES_AUTO="):
      old_auto = line.partition("=")[2]
      break
if old_auto is not None:
  updates["MSB_UPDATES_AUTO"] = old_auto
upsert_env(g, updates, drop)
print("ENV_OK", g)

# все bots/<id>/.env — убрать JARVIS_CC_ONLY
bots = live / "bots"
cleared = []
if bots.is_dir():
  for d in bots.iterdir():
    if not d.is_dir():
      continue
    envf = d / ".env"
    if not envf.exists():
      continue
    before = envf.read_text()
    upsert_env(envf, {}, drop)
    if before != envf.read_text():
      cleared.append(d.name)
print("JARVIS_CC_ONLY_CLEARED", ",".join(cleared) if cleared else "none")
PY

DROP_SRC="\$LIVE/${dropInSrcRel}"
if [[ -f "\$DROP_SRC" ]]; then
  if sudo -n true 2>/dev/null; then
    # Шаблонный drop-in: все текущие и будущие msb-bot@<id> стартуют через run.mjs.
    sudo -n mkdir -p /etc/systemd/system/msb-bot@.service.d
    sudo -n cp "\$DROP_SRC" /etc/systemd/system/msb-bot@.service.d/60-ext-entry.conf
    sudo -n systemctl daemon-reload
    echo DROPIN_OK
  else
    echo DROPIN_NEED_SUDO
  fi
fi

# Код общий (один bot/), Node держит старое в памяти — рестартим ВСЕ инстансы.
RESTARTED=""
restart_one() {
  local id="\$1"
  if command -v bot-ctl.sh >/dev/null 2>&1; then
    sudo -n bot-ctl.sh restart "\$id" || return 1
  else
    sudo -n systemctl restart "msb-bot@\$id" || return 1
  fi
  RESTARTED="\${RESTARTED:+\$RESTARTED }\$id"
  return 0
}
if sudo -n true 2>/dev/null; then
  if command -v bot-ctl.sh >/dev/null 2>&1 && sudo -n bot-ctl.sh restart all 2>/dev/null; then
    echo RESTARTED all
  else
    if [[ -d "\$LIVE/bots" ]]; then
      # default первым, остальные по имени
      mapfile -t _ids < <(find "\$LIVE/bots" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | awk '
        \$0=="default"{print "0\\t"\$0; next}
        {print "1\\t"\$0}
      ' | sort | cut -f2-)
      for id in "\${_ids[@]}"; do
        [[ "\$id" =~ ^[a-zA-Z0-9_-]{1,32}\$ ]] || continue
        restart_one "\$id" || echo "RESTART_FAIL \$id"
      done
    else
      restart_one default || sudo -n systemctl restart msb-bot || true
    fi
    echo "RESTARTED \${RESTARTED:-none}"
  fi
else
  echo RESTART_NEED_SUDO
fi
echo DONE
`;
}
