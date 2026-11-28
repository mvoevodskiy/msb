export function buildIiaMigrationScript({ skipBackup = false } = {}) {
  const skip = skipBackup ? '1' : '0';
  return `#!/bin/bash
set -euo pipefail
IIA=/home/client/.iia
MSB=/home/client/.msb
SKIP=${skip}
if [ ! -d "$IIA" ]; then
  echo IIA_NOT_FOUND
  exit 1
fi
if [ -f "$MSB/.migrated-from-iia" ]; then
  echo IIA_MIGRATED_ALREADY
  exit 0
fi
if [ -d "$MSB" ] && [ -n "$(ls -A "$MSB" 2>/dev/null || true)" ]; then
  echo IIA_MSB_EXISTS
  exit 1
fi
id client >/dev/null 2>&1 || { echo IIA_NO_CLIENT; exit 1; }
need_backup=$(du -sx -B1 "$IIA" | awk 'NR==1{print $1}')
need_copy=0
for name in .env bots engine; do
  if [ -e "$IIA/$name" ]; then
    part=$(du -sx -B1 "$IIA/$name" | awk 'NR==1{print $1}')
    need_copy=$((need_copy + part))
  fi
done
free_b=$(df -B1 --output=avail "$IIA" | awk 'END{print $1}')
need=$((need_backup + need_copy))
if [ -z "$need_backup" ] || [ -z "$free_b" ]; then
  if [ "$SKIP" = 1 ]; then
    echo "IIA_COPY_SPACE need=unknown free=unknown"
    exit 1
  fi
  echo "IIA_BACKUP_SPACE need=unknown free=unknown"
  exit 2
fi
if [ "$free_b" -lt "$need_copy" ]; then
  echo "IIA_COPY_SPACE need=$need_copy free=$free_b"
  exit 1
fi
backup=
if [ "$SKIP" != 1 ]; then
  if [ "$free_b" -lt "$need" ]; then
    echo "IIA_BACKUP_SPACE need=$need free=$free_b"
    exit 2
  fi
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup=/home/client/iia-backups/$stamp
  install -d -m 700 -o client -g client /home/client/iia-backups
  cp -a --one-file-system "$IIA" "$backup"
  chown -R client:client "$backup"
  echo "IIA_BACKUP $backup"
else
  echo IIA_BACKUP_SKIPPED
fi
install -d -m 700 -o client -g client "$MSB"
if [ -e "$IIA/.env" ]; then cp -a "$IIA/.env" "$MSB/.env"; fi
if [ -e "$IIA/engine" ]; then cp -a --one-file-system "$IIA/engine" "$MSB/engine"; fi
if [ -d "$IIA/bots" ]; then cp -a --one-file-system "$IIA/bots" "$MSB/bots"; fi
chown -R client:client "$MSB"
python3 - "$MSB" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1])
files = [root / ".env"]
bots = root / "bots"
if bots.is_dir():
    files.extend(path / ".env" for path in bots.iterdir() if path.is_dir())
for path in files:
    if not path.is_file():
        continue
    keys = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        keys.setdefault(key, value)
    extra = []
    for key, value in keys.items():
        if key.startswith("IIA_"):
            dest = "MSB_" + key[4:]
            if dest not in keys:
                extra.append(f"{dest}={value}")
    if extra:
        with path.open("a") as fh:
            fh.write("\\n" + "\\n".join(extra) + "\\n")
PY
if command -v systemctl >/dev/null 2>&1; then
  while read -r unit _; do
    case "$unit" in
      iia-bot@*) systemctl stop "$unit" || true; echo "IIA_STOPPED $unit" ;;
    esac
  done < <(systemctl list-units --type=service --all --no-legend 'iia-bot@*' 2>/dev/null || true)
fi
bindlist=$(mktemp)
python3 - "$IIA" "$MSB" "$bindlist" <<'PY'
import sys
from pathlib import Path
iia, msb, bindlist = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])

def unescape(field):
    out, i = [], 0
    while i < len(field):
        if field[i] == "\\\\" and i + 3 < len(field) and field[i + 1:i + 4].isdigit():
            out.append(chr(int(field[i + 1:i + 4], 8)))
            i += 4
        else:
            out.append(field[i])
            i += 1
    return "".join(out)

def escape(path):
    return path.replace("\\\\", "\\\\134").replace(" ", "\\\\040").replace("\\t", "\\\\011")

def split_fields(line):
    body, hashpos, comment = line, line.find(" #"), ""
    if hashpos != -1:
        body, comment = line[:hashpos], line[hashpos:]
    return body.split(), comment

files = [Path("/etc/fstab")]
extra = Path("/etc/fstab.d")
if extra.is_dir():
    files.extend(path for path in extra.iterdir() if path.is_file())
bots = iia / "bots"
lines = []
if not bots.is_dir():
    bindlist.write_text("")
    raise SystemExit(0)
for bot in sorted(path for path in bots.iterdir() if path.is_dir()):
    old, new = str(bot / "cwd"), str(msb / "bots" / bot.name / "cwd")
    source = ""
    for path in files:
        text = path.read_text()
        changed = []
        touched = False
        for raw in text.splitlines():
            fields, comment = split_fields(raw)
            if len(fields) >= 2 and unescape(fields[1]) == old:
                options = set(fields[3].split(",")) if len(fields) > 3 else set()
                if "bind" not in options:
                    raise SystemExit("foreign fstab entry for " + old)
                source = unescape(fields[0])
                fields[1] = escape(new)
                while len(fields) < 6:
                    fields.append("")
                if not fields[2]:
                    fields[2] = "none"
                fields[3] = "bind,nofail,x-systemd.device-timeout=1s"
                if not fields[4]:
                    fields[4] = "0"
                if not fields[5]:
                    fields[5] = "0"
                changed.append(" ".join(fields) + comment)
                touched = True
            else:
                changed.append(raw)
        if touched:
            path.write_text("\\n".join(changed) + ("\\n" if text.endswith("\\n") else ""))
    if source:
        lines.append(source + "\\t" + new + "\\t" + old)
bindlist.write_text("\\n".join(lines) + ("\\n" if lines else ""))
PY
while IFS=$'\\t' read -r source new old; do
  [ -n "$source" ] || continue
  mkdir -p "$new"
  if ! findmnt -rn "$new" >/dev/null 2>&1; then
    mount --bind "$source" "$new"
  fi
  if findmnt -rn "$old" >/dev/null 2>&1; then
    if ! umount "$old"; then
      umount "$new" || true
      echo IIA_BIND_BUSY
      exit 1
    fi
  fi
  echo "IIA_BIND $source $new"
done < "$bindlist"
rm -f "$bindlist"
date -u +%Y-%m-%dT%H:%M:%SZ > "$MSB/.migrated-from-iia"
echo "source=$IIA" >> "$MSB/.migrated-from-iia"
echo "backup=\${backup:-skipped}" >> "$MSB/.migrated-from-iia"
chown client:client "$MSB/.migrated-from-iia"
chmod 600 "$MSB/.migrated-from-iia"
echo IIA_MIGRATED
`;
}

export function parseBackupSpace(stdout) {
  const match = String(stdout || '').match(/IIA_BACKUP_SPACE need=(\d+|unknown) free=(\d+|unknown)/);
  if (!match) return null;
  return { need: match[1], free: match[2] };
}

export function parseBackupPath(stdout) {
  const match = String(stdout || '').match(/IIA_BACKUP (\S+)/);
  if (!match || match[1] === 'SKIPPED') return null;
  return match[1];
}
