"""Scoped inventory, protected-data comparison and test-proof checks."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import contract
import protected
import stage
import verify


class ScopedChecksTests(unittest.TestCase):
    def test_isolated_modules_resolve_sibling_dependencies(self):
        with tempfile.TemporaryDirectory(prefix='ag1-node-resolution-') as tmp:
            root = Path(tmp)
            modules = root / 'runtime' / contract.ISOLATED_DEPENDENCIES.name
            (modules / 'first').mkdir(parents=True)
            (modules / 'second').mkdir()
            (modules / 'first/index.js').write_text("module.exports = require('second')\n")
            (modules / 'second/index.js').write_text("module.exports = 42\n")
            source = root / 'source'; source.mkdir()
            (source / 'node_modules').symlink_to(modules, target_is_directory=True)
            result = subprocess.check_output(['node', '-e', "process.stdout.write(String(require('first')))"], cwd=source, text=True)
            self.assertEqual(result, '42')

    def test_changed_dependency_or_unexpected_file_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='ag1-inventory-') as tmp:
            root = Path(tmp).resolve()
            for name in ('src', 'shared', 'ext'): (root / name).mkdir()
            values = {
                'src/telegram/bot.mjs': (b'old-bot', b'new-bot'),
                'src/telegram/send-media.mjs': (b'old-media', b'new-media'),
                'src/telegram/media-markers.mjs': (b'old-markers', b'new-markers'),
            }
            files = {name: (name, contract.sha_bytes(old), contract.sha_bytes(new))
                     for name, (old, new) in values.items()}
            deps = {'src/telegram/response.mjs': b'response', 'src/agent/turn.mjs': b'turn',
                    'ext/shim/run-turn.mjs': b'shim'}
            entries = ('index.js', 'run.mjs', 'package.json', 'package-lock.json', 'OPEN-CORE.md')
            all_old = {name: old for name, (old, _) in values.items()} | deps | {name: name.encode() for name in entries}
            for name, data in all_old.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data); target.chmod(0o664)
            baseline = {name: {'sha256': contract.sha_bytes(data), 'mode': 0o664, 'source': name}
                        for name, data in all_old.items()}
            candidate = {name: value['sha256'] for name, value in baseline.items()}
            for name, (_, new) in values.items(): candidate[name] = contract.sha_bytes(new)
            manifest = {'baseline': baseline, 'runtime_inventory': candidate}
            with patch.object(contract, 'FILES', files), \
                 patch.object(contract, 'UNCHANGED', {name: contract.sha_bytes(value) for name, value in deps.items()}), \
                 patch.object(stage.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())), \
                 patch.object(stage.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=os.getgid())):
                stage.check_live_inventory(root, manifest, after=False)
                (root / 'src/telegram/response.mjs').write_bytes(b'other response')
                with self.assertRaisesRegex(RuntimeError, 'inventory drift'):
                    stage.check_live_inventory(root, manifest, after=False)
                (root / 'src/telegram/response.mjs').write_bytes(b'response')
                (root / 'src/other.mjs').write_bytes(b'unexpected')
                with self.assertRaisesRegex(RuntimeError, 'owner or mode|inventory drift'):
                    stage.check_live_inventory(root, manifest, after=False)

    def test_protected_snapshot_detects_changes_without_recording_content_on_disk(self):
        with tempfile.TemporaryDirectory(prefix='ag1-protected-') as tmp:
            home = Path(tmp)
            path = home / '.msb/bots/default/.env'
            path.parent.mkdir(parents=True)
            path.write_text('synthetic-secret-one')
            heartbeat = path.parent / '.heartbeat-ok'
            lock = path.parent / 'state.lock.sqlite'
            heartbeat.write_text('heartbeat-1')
            lock.write_text('lock-1')
            first = protected.snapshot(home)
            heartbeat.write_text('heartbeat-2')
            lock.write_text('lock-2')
            self.assertEqual(first, protected.snapshot(home))
            link = home / protected.PROFILE_LINK
            target = home / protected.PROFILE_LINK_TARGET
            link.parent.mkdir(parents=True)
            target.parent.mkdir(parents=True)
            target.write_text('synthetic profile')
            link.symlink_to(target)
            with_link = protected.snapshot(home)
            target.write_text('changed synthetic profile')
            self.assertNotEqual(with_link, protected.snapshot(home))
            link.unlink()
            target.unlink()
            wal = path.parent / 'state.lock.sqlite-wal'
            wal.write_text('protected-wal')
            self.assertNotEqual(first, protected.snapshot(home))
            wal.unlink()
            path.write_text('synthetic-secret-two')
            self.assertNotEqual(first, protected.snapshot(home))
            self.assertEqual(path.read_text(), 'synthetic-secret-two')

    def test_test_proof_rejects_skips_and_missing_cases(self):
        summary = '''AG1_OPERATOR_TESTS_BEGIN
Ran 11 tests in 0.1s
OK
AG1_OPERATOR_TESTS_END
AG1_TARGETED_TESTS_BEGIN
''' + '\n'.join(contract.REQUIRED_CASES) + '''
# tests 4
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
AG1_TARGETED_TESTS_END
'''
        self.assertEqual(verify.parse_tap(summary)['pass'], 4)
        with self.assertRaisesRegex(RuntimeError, 'fully pass'):
            verify.parse_tap(summary.replace('# skipped 0', '# skipped 1'))
        with self.assertRaisesRegex(RuntimeError, 'Required test'):
            verify.parse_tap(summary.replace(contract.REQUIRED_CASES[0], 'other'))


if __name__ == '__main__':
    unittest.main()
