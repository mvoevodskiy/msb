"""Old restore means move deletion trash into archive, never into active profile."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ipc import parse_request
from util import Refused
import archive_service
import cli
import state
from actions import archives

NAME = 'openclaw-20261012T123456Z'


class ArchiveRestoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name)) / '.msb'
        self.archive = self.root / 'archive'
        self.trash = self.archive / '.trash'
        self.trash.mkdir(parents=True)
        self.source = self.trash / NAME
        self.dest = self.archive / NAME

    def worker(self):
        import client_archive
        return client_archive

    def test_request_requires_bounded_old_archive_name(self):
        value = parse_request(f'{{"v":1,"id":"abcdefgh","action":"restore","archive":"{NAME}"}}'.encode())
        self.assertEqual(value['params']['archive'], NAME)
        for name in ('../escape', 'openclaw-20261012T123456Z/rest', 'other-20261012T123456Z'):
            with self.subTest(name=name), self.assertRaises(Refused):
                parse_request(f'{{"v":1,"id":"abcdefgh","action":"restore","archive":"{name}"}}'.encode())
        with self.assertRaises(Refused):
            parse_request(b'{"v":1,"id":"abcdefgh","action":"restore"}')

    def test_restore_merges_without_overwriting_and_never_touches_active_data(self):
        self.source.mkdir()
        self.dest.mkdir()
        (self.source / 'note.txt').write_text('old')
        (self.dest / 'note.txt').write_text('new')
        (self.dest / 'note.txt.restored').write_text('first')
        (self.source / 'nested').mkdir()
        (self.dest / 'nested').mkdir()
        (self.source / 'nested' / 'from-trash').write_text('trash')
        (self.dest / 'nested' / 'existing').write_text('archive')
        workspace = self.root / 'workspace'
        workspace.mkdir()
        (workspace / 'keep').write_text('live')
        result = self.worker().restore(str(self.root), NAME)
        self.assertEqual(result, {'archive': NAME, 'restored': 2})
        self.assertEqual((self.dest / 'note.txt').read_text(), 'new')
        self.assertEqual((self.dest / 'note.txt.restored').read_text(), 'first')
        self.assertEqual((self.dest / 'note.txt.restored.restored').read_text(), 'old')
        self.assertEqual((self.dest / 'nested' / 'from-trash').read_text(), 'trash')
        self.assertEqual((self.dest / 'nested' / 'existing').read_text(), 'archive')
        self.assertEqual((workspace / 'keep').read_text(), 'live')
        self.assertFalse(self.source.exists())

    def test_symlinks_are_moved_as_entries_not_followed(self):
        self.source.mkdir()
        self.dest.mkdir()
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('live')
        (self.source / 'source-link').symlink_to(outside, target_is_directory=True)
        (self.source / 'collision').mkdir()
        (self.source / 'collision' / 'item').write_text('trash')
        (self.dest / 'collision').symlink_to(outside, target_is_directory=True)
        self.worker().restore(str(self.root), NAME)
        self.assertTrue((self.dest / 'source-link').is_symlink())
        self.assertTrue((self.dest / 'collision').is_symlink())
        self.assertEqual((self.dest / 'collision.restored' / 'item').read_text(), 'trash')
        self.assertEqual((outside / 'keep').read_text(), 'live')
        self.assertFalse((outside / 'item').exists())

    def test_missing_or_symlink_source_is_nothing_to_restore(self):
        worker = self.worker()
        with self.assertRaises(worker.NothingToRestore):
            worker.restore(str(self.root), NAME)
        outside = self.root / 'outside'
        outside.mkdir()
        self.source.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(worker.NothingToRestore):
            worker.restore(str(self.root), NAME)
        self.assertTrue(self.source.is_symlink())

    def test_symlink_destination_is_not_entered(self):
        self.source.mkdir()
        (self.source / 'keep').write_text('trash')
        outside = self.root / 'outside'
        outside.mkdir()
        self.dest.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.worker().restore(str(self.root), NAME)
        self.assertEqual((self.source / 'keep').read_text(), 'trash')
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlinked_profile_root_is_not_traversed(self):
        alias = self.root.parent / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.worker().list_trash(str(alias))

    def test_symlinked_trash_directory_is_not_traversed(self):
        self.trash.rmdir()
        outside = self.root / 'outside'
        outside.mkdir()
        self.trash.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.worker().list_trash(str(self.root))
        self.assertEqual(list(outside.iterdir()), [])

    def test_collision_created_during_move_is_not_overwritten(self):
        worker = self.worker()
        self.source.mkdir()
        self.dest.mkdir()
        (self.source / 'item').write_text('trash')
        real = worker.rename_noreplace
        injected = False
        def collide(src, name, dst, target):
            nonlocal injected
            if not injected:
                injected = True
                (self.dest / 'item').write_text('racing')
            return real(src, name, dst, target)
        with patch.object(worker, 'rename_noreplace', side_effect=collide):
            worker.restore(str(self.root), NAME)
        self.assertEqual((self.dest / 'item').read_text(), 'racing')
        self.assertEqual((self.dest / 'item.restored').read_text(), 'trash')

    def test_partial_failure_keeps_remaining_source_for_retry(self):
        worker = self.worker()
        self.source.mkdir()
        (self.source / 'a').write_text('a')
        (self.source / 'b').write_text('b')
        real = worker.rename_noreplace
        count = 0
        def fail_second(*args):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError('synthetic move failure')
            return real(*args)
        with patch.object(worker, 'rename_noreplace', side_effect=fail_second):
            with self.assertRaises(OSError):
                worker.restore(str(self.root), NAME)
        self.assertEqual((self.dest / 'a').read_text(), 'a')
        self.assertEqual((self.source / 'b').read_text(), 'b')
        self.assertEqual(worker.restore(str(self.root), NAME)['restored'], 1)
        self.assertEqual((self.dest / 'b').read_text(), 'b')

    def test_moved_destination_directory_is_not_reported_as_success(self):
        worker = self.worker()
        self.source.mkdir()
        self.dest.mkdir()
        (self.source / 'nested').mkdir()
        (self.source / 'nested' / 'item').write_text('preserve')
        (self.dest / 'nested').mkdir()
        displaced = self.archive / 'moved-by-client'
        real = worker.rename_noreplace
        def move_then_displace(*args):
            real(*args)
            os.rename(self.dest / 'nested', displaced)
        with patch.object(worker, 'rename_noreplace', side_effect=move_then_displace):
            with self.assertRaises(OSError):
                worker.restore(str(self.root), NAME)
        self.assertEqual((displaced / 'item').read_text(), 'preserve')
        self.assertTrue(self.source.exists())

    def test_moved_archive_root_is_not_reported_as_success(self):
        worker = self.worker()
        self.source.mkdir()
        (self.source / 'item').write_text('preserve')
        displaced = self.root / 'moved-by-client'
        real = worker.rename_noreplace
        def move_then_displace(*args):
            real(*args)
            os.rename(self.archive, displaced)
        with patch.object(worker, 'rename_noreplace', side_effect=move_then_displace):
            with self.assertRaises(OSError):
                worker.restore(str(self.root), NAME)
        self.assertEqual((displaced / NAME / 'item').read_text(), 'preserve')

    def test_list_uses_real_entries_and_valid_dates(self):
        worker = self.worker()
        self.source.mkdir()
        (self.trash / 'jarvis-20261399T123456Z').mkdir()
        (self.trash / 'invalid').mkdir()
        (self.trash / 'jarvis-20261012T123456Z').symlink_to(self.source, target_is_directory=True)
        items = worker.list_trash(str(self.root))
        self.assertEqual(items, [{'archive': NAME, 'erase_after': None}])
        self.assertTrue(self.source.exists(), 'listing an old entry must not remove it')

    def test_restore_is_offered_only_for_an_observed_trash_entry(self):
        jarvis = {'installed': False}
        openclaw = {'installed': False}
        actions = state.available_actions(jarvis, openclaw, trash=[{'archive': NAME}])
        self.assertIn('restore', actions['client'])
        self.assertIn('restore', actions['openclaw'])
        self.assertNotIn('restore', state.available_actions(jarvis, openclaw, trash=None)['client'])
        with patch.object(archive_service, '_run', side_effect=Refused('FAILED')):
            self.assertIsNone(archive_service.list_trash(), 'an unreadable archive is unknown, not empty')

    def test_old_openclaw_source_retains_restore_route(self):
        payload = f'{{"v":1,"id":"abcdefgh","action":"restore","archive":"{NAME}"}}'.encode()
        with patch.object(archives, 'restore', return_value={'archive': NAME, 'restored': 2}) as restore, \
             patch.object(cli, 'spend', return_value=None), patch.object(cli, 'write_result') as result, \
             patch.object(cli, 'compute_state', return_value={}), patch.object(cli, 'write_state'):
            cli.handle('openclaw', payload)
        restore.assert_called_once_with(NAME)
        self.assertEqual(result.call_args_list[-1].args[:5], ('openclaw', 'abcdefgh', 'restore', 'done', 'OK'))

    @unittest.skipUnless(os.geteuid() == 0, 'requires isolated root with SETUID/SETGID')
    def test_dispatch_runs_real_worker_as_client_with_distinct_uid(self):
        self.source.mkdir()
        (self.source / 'payload').write_text('synthetic')
        uid = gid = 54321
        self.root.parent.chmod(0o755)
        for entry in (self.root, self.archive, self.trash, self.source, self.source / 'payload'):
            os.chown(entry, uid, gid)
        payload = f'{{"v":1,"id":"abcdefgh","action":"restore","archive":"{NAME}"}}'.encode()
        with patch.object(archive_service, 'CLIENT_ROOT', str(self.root)), \
             patch.object(archive_service, 'uid_of', return_value=uid), \
             patch.object(archive_service, 'gid_of', return_value=gid), \
             patch.object(cli, 'spend', return_value=None), patch.object(cli, 'write_result') as result, \
             patch.object(cli, 'compute_state', return_value={}), patch.object(cli, 'write_state'):
            self.assertEqual(archive_service.list_trash()[0]['archive'], NAME)
            cli.handle('client', payload)
        last = result.call_args_list[-1]
        self.assertEqual(last.args[:5], ('client', 'abcdefgh', 'restore', 'done', 'OK'))
        self.assertEqual(last.args[6], {'archive': NAME, 'restored': 1})
        self.assertEqual((self.dest / 'payload').read_text(), 'synthetic')
        self.assertEqual((self.dest / 'payload').stat().st_uid, uid)


if __name__ == '__main__':
    unittest.main()
