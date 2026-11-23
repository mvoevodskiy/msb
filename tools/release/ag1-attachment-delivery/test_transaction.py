"""Synthetic drift and interrupted exchange checks; no server or credentials."""

import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ag1_transaction', Path(__file__).with_name('transaction.py'))
tx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tx)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ag1-transaction-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root, self.stage, self.backup = (self.base / name for name in ('live', 'stage', 'backup'))
        self.root.mkdir()
        self.stage.mkdir()
        self.rows = []
        for number in range(3):
            relative = f'src/telegram/{number}.mjs'
            old, new = f'old-{number}'.encode(), f'new-{number}'.encode()
            live, payload = self.root / relative, self.stage / 'payload' / relative
            live.parent.mkdir(parents=True, exist_ok=True)
            payload.parent.mkdir(parents=True, exist_ok=True)
            live.write_bytes(old)
            live.chmod(0o664)
            payload.write_bytes(new)
            self.rows.append({'relative': relative, 'before_sha256': sha(old), 'after_sha256': sha(new)})
        (self.base / 'user-data').write_bytes(b'untouched')

    def prepare(self):
        return tx.prepare(self.root, self.stage, self.backup, self.rows, uid=os.getuid(), gid=os.getgid(),
                          mode=0o664, commit='a' * 40, manifest_sha='b' * 64)

    def test_baseline_drift_stops_before_any_publication(self):
        target = self.root / self.rows[1]['relative']
        target.write_bytes(b'independently changed')
        with self.assertRaisesRegex(RuntimeError, 'Baseline drift'):
            self.prepare()
        self.assertEqual((self.root / self.rows[0]['relative']).read_bytes(), b'old-0')
        self.assertEqual(target.read_bytes(), b'independently changed')
        self.assertEqual((self.base / 'user-data').read_bytes(), b'untouched')

    def test_partial_publication_rolls_back_and_recovery_is_idempotent(self):
        record = self.prepare()
        atomic = tx.P.atomic_write
        calls = 0
        def fail_after_second(*args, **kwargs):
            nonlocal calls
            atomic(*args, **kwargs)
            calls += 1
            if calls == 2:
                raise OSError('simulated interruption after exchange')
        with patch.object(tx.P, 'atomic_write', side_effect=fail_after_second):
            with self.assertRaisesRegex(OSError, 'simulated interruption'):
                tx.publish(self.root, self.stage, self.backup, record)
        self.assertEqual((self.root / self.rows[0]['relative']).read_bytes(), b'new-0')
        self.assertEqual((self.root / self.rows[1]['relative']).read_bytes(), b'new-1')
        self.assertEqual((self.root / self.rows[2]['relative']).read_bytes(), b'old-2')
        tx.rollback(self.root, self.backup, record)
        tx.rollback(self.root, self.backup, record)
        tx.verify_state(self.root, self.rows, after=False)
        self.assertEqual((self.base / 'user-data').read_bytes(), b'untouched')

    def test_rollback_refuses_independent_code_change(self):
        record = self.prepare()
        tx.publish(self.root, self.stage, self.backup, record)
        (self.root / self.rows[-1]['relative']).write_bytes(b'independent edit')
        with self.assertRaisesRegex(RuntimeError, 'independently changed'):
            tx.rollback(self.root, self.backup, record)
        self.assertEqual((self.root / self.rows[-1]['relative']).read_bytes(), b'independent edit')


if __name__ == '__main__':
    unittest.main()
