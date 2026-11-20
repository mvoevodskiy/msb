"""Isolated root-state writing contract; no host state or real credentials."""
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from util import Refused, ensure_root_dir, write_file
import ipc
import state


class PrivateStateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        self.private = self.root / 'private'
        self.private.mkdir(mode=0o700)
        self.dest = self.private / 'state.json'

    def test_writing_keeps_private_parent_mode(self):
        write_file(str(self.dest), b'new')
        self.assertEqual(stat.S_IMODE(self.private.stat().st_mode), 0o700)
        self.assertEqual(self.dest.read_bytes(), b'new')
        self.assertEqual(stat.S_IMODE(self.dest.stat().st_mode), 0o600)

    def test_actual_memory_and_status_writers_keep_distinct_parent_modes(self):
        run = self.root / 'run'
        marks = self.root / 'marks'
        with patch.object(ipc, 'STATE_DIR', str(self.private)), \
             patch.object(state, 'RUN_DIR', str(run)), \
             patch.object(state, 'STATE_DIR', str(self.private)), \
             patch.object(state, 'MARKS_DIR', str(marks)):
            ipc.save_memory({'client': {'seen': ['synthetic'], 'times': []}})
            state.write_state({'helper': 'fixture'})
        self.assertEqual(stat.S_IMODE(self.private.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(run.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(marks.stat().st_mode), 0o700)
        self.assertTrue((self.private / 'requests.json').is_file())
        self.assertTrue((run / 'state.json').is_file())

    def test_does_not_open_predictable_temp_symlink(self):
        victim = self.root / 'victim'
        victim.write_bytes(b'keep')
        (self.private / 'state.json.tmp').symlink_to(victim)
        write_file(str(self.dest), b'new')
        self.assertEqual(victim.read_bytes(), b'keep')
        self.assertTrue((self.private / 'state.json.tmp').is_symlink())
        self.assertEqual(self.dest.read_bytes(), b'new')

    def test_fsync_failure_keeps_previous_file_and_cleans_temporary(self):
        self.dest.write_bytes(b'previous')
        with patch('util.os.fsync', side_effect=OSError('synthetic disk error')):
            with self.assertRaises(OSError):
                write_file(str(self.dest), b'replacement')
        self.assertEqual(self.dest.read_bytes(), b'previous')
        self.assertEqual(sorted(p.name for p in self.private.iterdir()), ['state.json'])

    def test_short_writes_are_retried(self):
        original = os.write
        with patch('util.os.write', side_effect=lambda fd, data: original(fd, data[:1])):
            write_file(str(self.dest), b'abcdef')
        self.assertEqual(self.dest.read_bytes(), b'abcdef')

    def test_directory_sync_failure_reports_published_file_without_false_rollback(self):
        self.dest.write_bytes(b'previous')
        with patch('util.os.fsync', side_effect=[None, OSError('synthetic directory error')]), \
             patch('util.log') as log:
            write_file(str(self.dest), b'replacement')
        self.assertEqual(self.dest.read_bytes(), b'replacement')
        log.assert_called_once()
        self.assertIn('published, directory fsync failed', log.call_args.args[0])

    def test_ensure_root_dir_does_not_chmod_a_symlink_target(self):
        other = self.root / 'other'
        other.mkdir(mode=0o700)
        alias = self.root / 'alias'
        alias.symlink_to(other, target_is_directory=True)
        with self.assertRaises((OSError, Refused)):
            ensure_root_dir(str(alias), 0o755)
        self.assertEqual(stat.S_IMODE(other.stat().st_mode), 0o700)

    @unittest.skipUnless(os.geteuid() == 0, 'requires isolated root and distinct owner')
    def test_ensure_root_dir_refuses_other_owner(self):
        os.chown(self.private, 54321, 54321)
        with self.assertRaises(Refused):
            ensure_root_dir(str(self.private), 0o700)


if __name__ == '__main__':
    unittest.main()
