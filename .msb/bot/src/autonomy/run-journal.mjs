/**
 * Append one JSONL run without joining it to an interrupted previous record.
 * [Intervals](./scheduler.mjs) and [saved actions](./reminder-runs.mjs) keep
 * their append paths/modes; [history](./history.mjs) keeps its existing schemas.
 * [Recovery checks](../../tests/run-journal-recovery.test.mjs) cover real sends,
 * interval runs, linked journals and write-only access. No delivery is retried.
 */
import fs from 'node:fs/promises';

async function needsSeparator(file) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (!size) return false;
      const last = Buffer.alloc(1);
      const { bytesRead } = await handle.read(last, 0, 1, size - 1);
      return bytesRead > 0 && last[0] !== 10;
    } finally { await handle.close(); }
  } catch (error) {
    // Reading is only an optimization to avoid blank lines. A write-only
    // journal can still be appended; its readers already ignore empty lines.
    return error?.code !== 'ENOENT';
  }
}

export async function appendRunRecord(file, row, options) {
  const separator = await needsSeparator(file) ? '\n' : '';
  await fs.appendFile(file, separator + JSON.stringify(row) + '\n', options);
}
