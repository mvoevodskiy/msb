// Provider routing for Pult only. state.engine=cc is a CLI channel, not a provider.
import { join } from 'node:path';
import { readJsonFile } from '../util.ts';
export function activeProvider(dir: string): string {
  const state = readJsonFile(join(dir, 'state.json')) as { engine?: unknown } | null;
  if (state?.engine === 'oc') return 'openclaw';
  const store = readJsonFile(join(dir, 'ext-providers.json')) as { active?: unknown } | null;
  // No overlay means the original native Claude route. Unknown providers never borrow its quota.
  return typeof store?.active === 'string' ? store.active : 'claude';
}
