function shSingle(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildAccessScript({ publicKey, username }) {
  const key = shSingle(String(publicKey || '').trim());
  const user = username || 'root';
  const sudo = user === 'root'
    ? ''
    : `
if [ "$(id -u)" -ne 0 ]; then
  echo "$(id -un) ALL=(root) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/msb-install-once >/dev/null
  sudo chmod 440 /etc/sudoers.d/msb-install-once
  sudo visudo -cf /etc/sudoers.d/msb-install-once
fi
`;
  return `bash <<'EOF'
set -euo pipefail
KEY=${key}
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
grep -qxF "$KEY" "$HOME/.ssh/authorized_keys" || echo "$KEY" >> "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
${sudo}EOF`;
}
