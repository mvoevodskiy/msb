import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import deploy
import fleet


def load_base():
    path = Path(__file__).resolve().parents[1] / 'jar1-audit-2026-11-20/deploy.py'
    spec = importlib.util.spec_from_file_location('audit_transaction', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FakeHost:
    def __init__(self):
        self.running = set(deploy.BOTS)
        self.masked = set()
        self.identity = {name: sha(name.encode()) for name in deploy.BOTS}
        self.settings = {'default': 'saved-session', 'mistrjarvis': None}
        self.fail_stop = None
        self.fail_mask = None
        self.fail_ready = None
        self.events = []
        self.check_code = lambda: None

    def system_idle(self): pass
    def trusted_admin_directories(self): pass
    def marker_absent(self): pass
    def support_inventory(self, entries): pass
    def pending_status(self): return None
    def runtime_identity(self, stage): return {'node_sha256': 'node'}
    def network_inode(self, bot=True): return 100
    def bot_node_sha(self): return 'node'
    def polling_identity(self): return self.identity.copy()
    def protected(self): return copy.deepcopy(self.settings)
    def valid_identity(self, identity): return identity in self.identity.values()

    def bot_idle(self):
        if self.running != set(deploy.BOTS):
            raise RuntimeError('Both bots are required to be idle and active')

    def require_unmasked(self):
        if self.masked:
            raise RuntimeError('A unit is already masked')

    def arm_all(self, recover=False):
        for unit in deploy.BOTS:
            if unit == self.fail_mask:
                raise RuntimeError('Mask failed')
            self.masked.add(unit)
        self.events.append('masked')

    def stop_all(self, recover=False):
        if self.masked != set(deploy.BOTS):
            raise RuntimeError('Must be masked before stop')
        errors = set()
        for unit in deploy.BOTS:
            if unit == self.fail_stop:
                errors.add(unit)
            else:
                self.running.discard(unit)
        self.events.append('stopped')
        if errors:
            raise RuntimeError('Stop failed')

    def start_all(self, identity):
        self.check_code()
        self.masked.clear()
        self.running.update(deploy.BOTS)
        self.events.append('started both')
        if self.fail_ready:
            raise RuntimeError('Polling failed on one bot')


class TwoBotTransactionTests(unittest.TestCase):
    def setUp(self):
        self.base = load_base()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.roots = {name: self.root / name for name in ('bot', 'engine', 'bin')}
        for root in self.roots.values():
            root.mkdir()
        self.stage = self.root / 'stage'
        self.backup = self.root / 'backup'
        self.existing, self.added = 'src/existing.mjs', 'src/new.mjs'
        self.base.ANCHOR = {'bot': self.existing}
        self.base.RELEASE_ORDER = [('bot', self.existing), ('bot', self.added)]
        self.base.ADDED = {('bot', self.added)}
        self.native = {'host_netns_inode': 100, 'wrapper_sha256': 'wrapper', 'binary_sha256': 'native'}
        mock = patch.object(self.base, 'cli_fingerprint', return_value={
            key: self.native[key] for key in ('wrapper_sha256', 'binary_sha256')})
        mock.start()
        self.addCleanup(mock.stop)
        self.base.bot_owner = lambda: (os.geteuid(), os.getegid(), 0o664)
        (self.stage / 'payload/bot/src').mkdir(parents=True)
        old = self.roots['bot'] / self.existing
        old.parent.mkdir()
        old.write_bytes(b'old')
        old.chmod(0o664)
        self.initial_inode = old.stat().st_ino
        tool = self.roots['bin'] / 'bot-ctl.sh'
        tool.write_bytes(b'tool')
        tool.chmod(0o755)
        files = []
        for name, before in ((self.existing, sha(b'old')), (self.added, None)):
            after = ('new:' + name).encode()
            (self.stage / 'payload/bot' / name).write_bytes(after)
            files.append({'root': 'bot', 'relative': name, 'source': '.msb/bot/' + name,
                          'before_sha256': before, 'after_sha256': sha(after)})
        manifest = {'source_commit': 'a' * 40, 'support_files': [], 'files': files, 'baseline_inventory': [
            {'root': 'bot', 'relative': self.existing, 'sha256': sha(b'old')},
            {'root': 'bin', 'relative': 'bot-ctl.sh', 'sha256': sha(b'tool')},
        ]}
        self.host = FakeHost()
        self.release = deploy.deployment(self.base)(self.stage, self.backup, self.roots, self.host,
                                                    manifest, {'node_sha256': 'node'}, self.native)
        self.host.check_code = self.check_complete_state

    def check_complete_state(self):
        root = self.roots['bot']
        prior = (root / self.existing).read_bytes() == b'old'
        self.assertEqual((root / self.added).exists(), not prior, 'never start a partial tree')

    def assert_restored(self):
        original = self.roots['bot'] / self.existing
        self.assertEqual(original.read_bytes(), b'old')
        self.assertEqual(original.stat().st_ino, self.initial_inode)
        self.assertFalse((self.roots['bot'] / self.added).exists())
        self.assertEqual(self.host.running, set(deploy.BOTS))
        self.assertFalse(self.host.masked)

    def test_plan_has_no_writes_or_service_changes(self):
        self.release.check()
        self.assertFalse(self.backup.exists())
        self.assertEqual(self.host.events, [])
        self.assert_restored()

    def test_apply_and_rollback_restore_both_bots_and_original_inode(self):
        protected = self.host.protected()
        self.release.apply()
        self.assertEqual(self.host.events, ['masked', 'stopped', 'started both'])
        self.assertTrue((self.roots['bot'] / self.added).is_file())
        self.release.rollback()
        self.assert_restored()
        self.assertEqual(self.host.protected(), protected)

    def test_second_stop_or_mask_failure_restarts_both_with_original_code(self):
        for attr in ('fail_mask', 'fail_stop'):
            with self.subTest(attr=attr):
                self.release.backup = self.root / attr
                setattr(self.host, attr, 'mistrjarvis')
                with self.assertRaisesRegex(RuntimeError, 'restored previous code and both'):
                    self.release.apply()
                setattr(self.host, attr, None)
                self.assert_restored()

    def test_publish_failure_after_exchange_rolls_back_before_either_restarts(self):
        original = self.base.atomic_write
        def fail(*args, **kwargs):
            self.assertFalse(self.host.running)
            self.assertEqual(self.host.masked, set(deploy.BOTS))
            original(*args, **kwargs)
            raise OSError('Publication failed after atomic exchange')
        with patch.object(self.base, 'atomic_write', side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, 'restored previous code and both'):
                self.release.apply()
        self.assert_restored()

    def test_failed_startup_rolls_back_but_preserves_available_bot(self):
        self.host.fail_ready = 'mistrjarvis'
        with self.assertRaisesRegex(RuntimeError, 'recovery incomplete'):
            self.release.apply()
        self.assert_restored()
        self.assertTrue((self.backup / 'guard.pending').exists())
        self.host.fail_ready = None
        self.release.rollback()
        self.assertFalse((self.backup / 'guard.pending').exists())
        self.assert_restored()

    def test_retry_partial_rollback_respects_mask_until_old_tree_is_complete(self):
        self.release.apply()
        original = self.base.remove_created
        def fail(*args, **kwargs):
            original(*args, **kwargs)
            raise OSError('Interrupted after one restore operation')
        with patch.object(self.base, 'remove_created', side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, 'retain startup guards'):
                self.release.rollback()
        self.assertFalse(self.host.running)
        self.assertEqual(self.host.masked, set(deploy.BOTS))
        self.release.rollback()
        self.assert_restored()

    def test_independent_code_change_refused_before_stop(self):
        self.release.apply()
        changed = self.roots['bot'] / self.existing
        changed.write_bytes(b'independent')
        with self.assertRaisesRegex(RuntimeError, 'independently changed'):
            self.release.rollback()
        self.assertEqual(changed.read_bytes(), b'independent')
        self.assertEqual(self.host.running, set(deploy.BOTS))

    def test_start_attempts_other_unit_when_the_first_start_fails(self):
        host = fleet.host_class(self.base)()
        identity = self.host.identity
        calls = []
        def command(action, bot):
            calls.append((action, bot))
            if bot == 'default':
                raise RuntimeError('start error')
        with patch.object(host, 'masked', return_value=False), patch.object(host, 'command', side_effect=command), \
                patch.object(host, 'current_identity', side_effect=identity.__getitem__):
            with self.assertRaisesRegex(RuntimeError, 'failed for bot units: default'):
                host.start_all(identity)
        self.assertEqual(calls, [('start', 'default'), ('start', 'mistrjarvis')])


if __name__ == '__main__':
    unittest.main()
