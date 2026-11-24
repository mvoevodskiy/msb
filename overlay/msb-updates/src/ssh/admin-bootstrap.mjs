function shSingle(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildAdminBootstrapScript(publicKey) {
  const key = shSingle(String(publicKey || '').trim());
  return `#!/bin/bash
set -euo pipefail
PUB=${key}
id msb-admin >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group msb-admin
id client >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group client
install -d -m 700 -o msb-admin -g msb-admin /home/msb-admin/.ssh
touch /home/msb-admin/.ssh/authorized_keys
grep -qxF "$PUB" /home/msb-admin/.ssh/authorized_keys || echo "$PUB" >> /home/msb-admin/.ssh/authorized_keys
chown msb-admin:msb-admin /home/msb-admin/.ssh/authorized_keys
chmod 600 /home/msb-admin/.ssh/authorized_keys
printf '%s\\n' 'msb-admin ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/msb-admin
chmod 440 /etc/sudoers.d/msb-admin
visudo -cf /etc/sudoers.d/msb-admin
rm -f /etc/sudoers.d/msb-install-once
echo MSB_ADMIN_READY
`;
}

export function buildDropAdminKeyScript(publicKey) {
  const key = shSingle(String(publicKey || '').trim());
  return `#!/bin/bash
set -euo pipefail
PUB=${key}
f="$HOME/.ssh/authorized_keys"
[ -f "$f" ] || { echo MSB_ADMIN_KEY_REMOVED; exit 0; }
grep -vxF "$PUB" "$f" > "$f.msb-tmp" || true
cat "$f.msb-tmp" > "$f"
rm -f "$f.msb-tmp"
chmod 600 "$f"
echo MSB_ADMIN_KEY_REMOVED
`;
}

export function nextSetupAction(intent) {
  if (!intent || intent.type !== 'system_setup') return 'skip';
  if (intent.host) return 'bootstrap';
  if (intent.provider_server_id) return 'refresh';
  if (intent.platform_account_id) return 'create';
  return 'need_host';
}
