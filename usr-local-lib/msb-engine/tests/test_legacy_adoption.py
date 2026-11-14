"""Migration copies only validated synthetic OpenClaw system facts; no live units."""
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from util import Refused

IID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'


class LegacyAdoptionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        self.old = self.root / 'old'
        self.new = self.root / 'new'
        self.home = self.root / 'openclaw'
        self.old.mkdir(mode=0o700)
        self.home.mkdir(mode=0o700)
        self.uid = os.getuid() or 54321
        if os.getuid() == 0:
            os.chown(self.home, self.uid, self.uid)
        self.target = {'unit': 'openclaw-gateway.service', 'scope': 'user'}

    def module(self):
        import legacy_adoption
        return legacy_adoption

    def marker(self, uid=None, iid=IID):
        (self.old / 'openclaw.installed').write_text(
            f'uid={self.uid if uid is None else uid}\ninstallation_id={iid}\nowner=42\n'
            'port=19300\nversion=2026.9.5\ncomplete=1\n')

    def adopt(self, target=None, uid=None):
        return self.module().adopt(str(self.old), str(self.new), str(self.home),
                                   self.target if target is None else target,
                                   self.uid if uid is None else uid)

    def test_preserves_old_facts_and_copies_off_before_completed_marker(self):
        self.marker()
        (self.old / 'openclaw.setup').write_text(f'installation_id={IID}\nconfigured=0\nbeside_adapter=1\n')
        (self.old / 'openclaw.off').write_text('off')
        self.assertEqual(self.adopt(), 'adopted')
        self.assertIn(f'installation_id={IID}', (self.new / 'openclaw.installed').read_text())
        self.assertIn('configured=0', (self.new / 'openclaw.setup').read_text())
        self.assertTrue((self.new / 'openclaw.off').exists())
        self.assertTrue((self.old / 'openclaw.installed').exists())
        self.assertEqual(stat.S_IMODE((self.new / 'openclaw.installed').stat().st_mode), 0o600)

    def test_absent_legacy_is_non_destructive(self):
        self.assertEqual(self.adopt(), 'absent')
        self.assertFalse(self.new.exists())

    def test_missing_legacy_after_interruption_is_an_explicit_conflict(self):
        self.new.mkdir(mode=0o700)
        (self.new / 'openclaw-adoption.pending').write_text('installation_id=fixture\n')
        with self.assertRaises(Refused) as refused:
            self.adopt()
        self.assertEqual(refused.exception.detail['reason'], 'ADOPTION_SOURCE_MISSING')
        self.assertTrue((self.new / 'openclaw-adoption.pending').exists())

    def test_other_unit_wrong_uid_or_linked_home_cannot_be_adopted(self):
        self.marker()
        for target, uid in (({'unit': 'openclaw.service', 'scope': 'system'}, self.uid),
                            (self.target, self.uid + 1)):
            with self.subTest(target=target, uid=uid), self.assertRaises(Refused):
                self.adopt(target, uid)
            self.assertFalse(self.new.exists())
        alias = self.root / 'alias'
        alias.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(Refused):
            self.module().adopt(str(self.old), str(self.new), str(alias), self.target, self.uid)

    def test_existing_unrelated_new_installation_is_never_overwritten(self):
        self.marker()
        self.new.mkdir(mode=0o700)
        current = self.new / 'openclaw.installed'
        current.write_text('installation_id=bbbbbbbb-cccc-dddd-eeee-ffffffffffff\ncomplete=1\n')
        before = current.read_bytes()
        with self.assertRaises(Refused):
            self.adopt()
        self.assertEqual(current.read_bytes(), before)
        self.assertTrue((self.old / 'openclaw.installed').exists())

    def test_mismatched_setup_is_not_published_as_ready(self):
        self.marker()
        (self.old / 'openclaw.setup').write_text('installation_id=bbbbbbbb-cccc-dddd-eeee-ffffffffffff\nconfigured=1\n')
        with self.assertRaises(Refused):
            self.adopt()
        self.assertFalse((self.new / 'openclaw.installed').exists())

    def test_untrusted_marker_is_not_followed_or_copied(self):
        self.marker()
        original = self.old / 'openclaw.installed'
        other = self.root / 'outside-marker'
        original.rename(other)
        original.symlink_to(other)
        with self.assertRaises(Refused):
            self.adopt()
        self.assertTrue(original.is_symlink())
        self.assertFalse(self.new.exists())

    def test_linked_or_writable_legacy_directory_is_refused(self):
        self.marker()
        alias = self.root / 'legacy-alias'
        alias.symlink_to(self.old, target_is_directory=True)
        with self.assertRaises(Refused):
            self.module().adopt(str(alias), str(self.new), str(self.home), self.target, self.uid)
        self.old.chmod(0o777)
        with self.assertRaises(Refused):
            self.adopt()
        self.assertFalse(self.new.exists())

    def test_unrelated_secret_fields_are_not_copied(self):
        self.marker()
        with (self.old / 'openclaw.installed').open('a') as file:
            file.write('token=synthetic-secret\n')
        self.assertEqual(self.adopt(), 'adopted')
        self.assertNotIn('synthetic-secret', (self.new / 'openclaw.installed').read_text())
        self.assertIn('synthetic-secret', (self.old / 'openclaw.installed').read_text())

    def test_same_installation_is_not_overwritten_and_off_intent_is_preserved(self):
        self.marker()
        (self.old / 'openclaw.off').write_text('off')
        self.assertEqual(self.adopt(), 'adopted')
        current = self.new / 'openclaw.installed'
        before = current.read_bytes()
        (self.new / 'openclaw.off').unlink()  # an explicit start after adoption
        self.assertEqual(self.adopt(), 'already')
        self.assertEqual(current.read_bytes(), before)
        self.assertFalse((self.new / 'openclaw.off').exists(), 'repeat must not undo an explicit start')

    def test_repeat_refuses_conflicting_setup_instead_of_claiming_ready(self):
        self.marker()
        (self.old / 'openclaw.setup').write_text(f'installation_id={IID}\nconfigured=0\n')
        self.assertEqual(self.adopt(), 'adopted')
        (self.new / 'openclaw.setup').unlink()
        with self.assertRaises(Refused):
            self.adopt()

    def test_adopted_complete_marker_is_not_a_live_channel_proof(self):
        from openclaw_readiness import incomplete
        self.marker()
        (self.old / 'openclaw.setup').write_text(f'installation_id={IID}\nconfigured=1\n')
        self.assertEqual(self.adopt(), 'adopted')
        self.assertIsNone(incomplete(str(self.new / 'openclaw.installed'), str(self.new / 'openclaw.setup')))

    def test_interrupted_copy_keeps_incomplete_new_marker_unpublished_and_can_retry(self):
        module = self.module()
        self.marker()
        (self.old / 'openclaw.setup').write_text(f'installation_id={IID}\nconfigured=0\n')
        (self.old / 'openclaw.off').write_text('off')
        original = module.write_file
        def fail_marker(path, data, mode=0o600):
            if Path(path).name == 'openclaw.installed':
                raise OSError('synthetic failure')
            return original(path, data, mode)
        with patch.object(module, 'write_file', side_effect=fail_marker):
            with self.assertRaises(OSError):
                self.adopt()
        self.assertTrue((self.new / 'openclaw.setup').exists())
        self.assertTrue((self.new / 'openclaw.off').exists())
        self.assertTrue((self.new / 'openclaw-adoption.pending').exists())
        self.assertFalse((self.new / 'openclaw.installed').exists())
        from actions import openclaw
        info = {'installed': True, 'enabled': False, 'unit': 'openclaw-gateway.service',
                'scope': 'user', 'adoption_pending': True}
        with patch.object(openclaw, 'openclaw_info', return_value=info), \
             patch.object(openclaw, 'oc_service_ok') as start:
            with self.assertRaises(Refused) as refused:
                openclaw.act_enable_openclaw('client', {'params': {}}, lambda *_: None)
        self.assertEqual(refused.exception.detail['reason'], 'ADOPTION_PENDING')
        start.assert_not_called()
        self.assertEqual(self.adopt(), 'adopted')
        self.assertTrue((self.new / 'openclaw.installed').exists())
        self.assertFalse((self.new / 'openclaw-adoption.pending').exists())

    def test_legacy_changes_during_interrupted_copy_refuse_retry(self):
        module = self.module()
        self.marker()
        original = module.write_file
        def fail_marker(path, data, mode=0o600):
            if Path(path).name == 'openclaw.installed':
                raise OSError('synthetic')
            return original(path, data, mode)
        with patch.object(module, 'write_file', side_effect=fail_marker):
            with self.assertRaises(OSError):
                self.adopt()
        (self.old / 'openclaw.off').write_text('changed after interrupted copy')
        with self.assertRaises(Refused) as refused:
            self.adopt()
        self.assertEqual(refused.exception.detail['reason'], 'ADOPTION_PENDING_CONFLICT')
        self.assertFalse((self.new / 'openclaw.installed').exists())

    def test_interruption_after_marker_can_finish_without_losing_off_intent(self):
        module = self.module()
        self.marker()
        (self.old / 'openclaw.off').write_text('off')
        pending = self.new / 'openclaw-adoption.pending'
        original = os.unlink
        def fail_pending(path, *args, **kwargs):
            if str(path) == str(pending):
                raise PermissionError('synthetic')
            return original(path, *args, **kwargs)
        with patch.object(module.os, 'unlink', side_effect=fail_pending):
            with self.assertRaises(PermissionError):
                self.adopt()
        self.assertTrue((self.new / 'openclaw.installed').exists())
        self.assertTrue((self.new / 'openclaw.off').exists())
        self.assertTrue(pending.exists())
        self.assertEqual(self.adopt(), 'already')
        self.assertFalse(pending.exists())
        self.assertTrue((self.new / 'openclaw.off').exists())


if __name__ == '__main__':
    unittest.main()
