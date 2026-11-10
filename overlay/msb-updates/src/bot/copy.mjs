import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadSshInstruction({ publicKey, egressIps }) {
  const tplPath = path.join(__dirname, 'copy', 'ssh-access.ru.md');
  let tpl = fs.readFileSync(tplPath, 'utf8');
  const ips = (egressIps && egressIps.length) ? egressIps.join(', ') : '(IP хаба ещё не задан — спроси администратора)';
  tpl = tpl.replaceAll('{{PUBLIC_KEY}}', publicKey || '(ключ ещё генерируется)');
  tpl = tpl.replaceAll('{{EGRESS_IPS}}', ips);
  return tpl.trim();
}
