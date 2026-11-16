/** Separate synthetic writer for the monitor source-snapshot regression. */
import { loadMonitorConfig, saveMonitorConfig } from '../../src/monitor/config.mjs';
const cfg = await loadMonitorConfig();
cfg.youtube.channels[0] = { ...cfg.youtube.channels[0], name: 'external-replacement',
  enabled: false, marker: 'other-process', lastError: 'newer-result' };
await saveMonitorConfig(cfg);
