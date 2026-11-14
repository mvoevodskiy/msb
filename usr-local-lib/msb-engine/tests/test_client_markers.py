"""Real distinct-UID marker writes in a disposable Linux container."""
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from util import Refused, as_client_touch
from actions import bots


@unittest.skipUnless(os.geteuid() == 0, 'requires isolated root with SETUID/SETGID')
class ClientMarkerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        self.root.chmod(0o755)
        self.directory = self.root / 'engine'
        self.directory.mkdir(mode=0o700)
        self.uid = self.gid = 54321
        os.chown(self.directory, self.uid, self.gid)
        self.mark = self.directory / 'sleep.default'
        self.uids = patch('util.uid_of', return_value=self.uid)
        self.gids = patch('util.gid_of', return_value=self.gid)
        self.uids.start()
        self.gids.start()
        self.addCleanup(self.uids.stop)
        self.addCleanup(self.gids.stop)

    def test_marker_is_created_by_client_and_removed(self):
        as_client_touch(str(self.mark), b'at=synthetic\n')
        self.assertEqual(self.mark.read_bytes(), b'at=synthetic\n')
        self.assertEqual(self.mark.stat().st_uid, self.uid)
        self.assertEqual(stat.S_IMODE(self.mark.stat().st_mode), 0o600)
        as_client_touch(str(self.mark), None)
        self.assertFalse(self.mark.exists())
        self.assertEqual(self.directory.stat().st_uid, self.uid)

    def test_existing_sleep_action_changes_only_requested_bot(self):
        with patch.object(bots, 'SOURCES', (('client', str(self.directory), 'client'),)):
            bots.set_sleep(['default'], True, 'synthetic-id')
            self.assertEqual(self.mark.read_bytes(), b'at=synthetic-id\n')
            self.assertFalse((self.directory / 'sleep.other').exists())
            bots.set_sleep(['default'], False, 'synthetic-id')
        self.assertFalse(self.mark.exists())

    def test_existing_symlink_is_replaced_without_touching_target(self):
        victim = self.root / 'root-owned'
        victim.write_bytes(b'preserve')
        victim.chmod(0o600)
        self.mark.symlink_to(victim)
        as_client_touch(str(self.mark), b'sleep')
        self.assertEqual(victim.read_bytes(), b'preserve')
        self.assertEqual(victim.stat().st_uid, 0)
        self.assertFalse(self.mark.is_symlink())
        self.assertEqual(self.mark.read_bytes(), b'sleep')

    def test_removing_symlink_does_not_unlink_its_target(self):
        victim = self.root / 'root-owned'
        victim.write_bytes(b'preserve')
        self.mark.symlink_to(victim)
        as_client_touch(str(self.mark), None)
        self.assertEqual(victim.read_bytes(), b'preserve')
        self.assertFalse(self.mark.is_symlink())

    def test_removing_absent_marker_does_not_create_parent(self):
        missing = self.root / 'absent' / 'engine' / 'sleep.default'
        as_client_touch(str(missing), None)
        self.assertFalse((self.root / 'absent').exists())

    def test_nonempty_marker_directory_is_preserved_on_failure(self):
        self.mark.mkdir()
        (self.mark / 'keep').write_bytes(b'preserve')
        with self.assertRaises(Refused):
            as_client_touch(str(self.mark), b'sleep')
        self.assertEqual((self.mark / 'keep').read_bytes(), b'preserve')

    def test_refuses_symlink_directory_without_changing_target(self):
        other = self.root / 'protected'
        other.mkdir(mode=0o700)
        alias = self.root / 'alias'
        alias.symlink_to(other, target_is_directory=True)
        with self.assertRaises(Refused):
            as_client_touch(str(alias / 'sleep.default'), b'sleep')
        self.assertEqual(other.stat().st_uid, 0)
        self.assertFalse((other / 'sleep.default').exists())


if __name__ == '__main__':
    unittest.main()
