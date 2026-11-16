"""Dedicated OS-user profile checks; fake CLI and files under a temporary root."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from util import Refused


class ProfileTest(unittest.TestCase):
    def setUp(self):
        import openclaw_profile as module
        self.m = module
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        if os.geteuid() == 0:
            self.root.chmod(0o755)
        self.home = self.root / 'home'
        self.profile = self.home / '.openclaw'
        self.profile.mkdir(parents=True, mode=0o700)
        self.config = self.profile / 'openclaw.json'
        self.config.write_text('{"fixture":true}')
        self.config.chmod(0o600)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.marker = self.state / 'openclaw.installed'
        self.setup = self.state / 'openclaw.setup'
        self.uid = os.geteuid() if os.geteuid() else 54321
        self.gid = os.getegid() if os.getegid() else 54321
        if os.geteuid() == 0:
            os.chown(self.home, self.uid, self.gid)
            os.chown(self.profile, self.uid, self.gid)
            os.chown(self.config, self.uid, self.gid)
        self.iid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        self.marker.write_text(f'uid={self.uid}\ninstallation_id={self.iid}\ncomplete=1\nport=19300\n')
        self.setup.write_text(f'installation_id={self.iid}\nconfigured=1\n')
        self.target = {'installed': True, 'enabled': True, 'incomplete': False, 'gateway': 'active',
                       'scope': 'user', 'unit': 'openclaw-gateway.service', 'adoption_pending': False}
        self.patches = [patch.object(module, 'OC_HOME', str(self.home)),
                        patch.object(module, 'OC_MARKER', str(self.marker)),
                        patch.object(module, 'OC_SETUP', str(self.setup)),
                        patch.object(module, 'uid_of', return_value=self.uid),
                        patch.object(module, 'gid_of', return_value=self.gid),
                        patch.object(module, 'openclaw_info', return_value=self.target)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def cli(self, args, **kwargs):
        if args == ['config', 'get', 'gateway.mode', '--json']:
            return 0, b'"local"'
        if args == ['gateway', 'call', 'config.get', '--json']:
            import json
            return 0, json.dumps({'path': str(self.config)}).encode()
        self.fail('unexpected command')

    def test_matching_active_user_gateway_and_profile_are_captured(self):
        with patch.object(self.m, 'run_cli', side_effect=self.cli):
            proof = self.m.capture()
            self.assertEqual((proof.uid, proof.gid, proof.installation_id), (self.uid, self.gid, self.iid))
            self.assertTrue(self.m.unchanged(proof))

    def test_foreign_or_ambiguous_target_never_invokes_cli(self):
        for patching in ({'scope': 'system'}, {'unit': None}, {'gateway': 'inactive'},
                         {'enabled': False}, {'incomplete': None}, {'incomplete': True}, {'adoption_pending': True}):
            with self.subTest(patching=patching), patch.object(self.m, 'openclaw_info', return_value={**self.target, **patching}), \
                 patch.object(self.m, 'run_cli') as cli, self.assertRaises(Refused):
                self.m.capture()
            cli.assert_not_called()

    def test_adopted_legacy_facts_stay_unknown_until_association_is_proved(self):
        import state
        self.marker.write_text(self.marker.read_text() + 'adopted_legacy=1\n')
        descriptor = {'unit': 'openclaw-gateway.service', 'scope': 'user'}
        with patch.object(state, 'OC_MARKER', str(self.marker)), \
             patch.object(state, 'OC_SETUP', str(self.setup)), \
             patch.object(state, 'LEGACY_OC_MARKER', str(self.root / 'no-legacy')), \
             patch.object(state, 'LEGACY_ADOPTION_PENDING', str(self.root / 'no-pending')), \
             patch.object(state, 'OC_HOME', str(self.home)), \
             patch.object(state, 'discover_oc_service', return_value=descriptor), \
             patch.object(state, 'openclaw_off_paths', return_value=[]), \
             patch.object(state, 'oc_service_word', return_value='active'), \
             patch.object(self.m, 'openclaw_info', state.openclaw_info), \
             patch.object(self.m, 'run_cli') as cli, self.assertRaises(Refused):
            self.m.capture()
        cli.assert_not_called()

    def test_incomplete_or_mismatched_root_setup_is_rejected(self):
        for text in (f'installation_id={self.iid}\nconfigured=0\n',
                     'installation_id=bbbbbbbb-cccc-dddd-eeee-ffffffffffff\nconfigured=1\n'):
            self.setup.write_text(text)
            with patch.object(self.m, 'run_cli') as cli, self.assertRaises(Refused):
                self.m.capture()
            cli.assert_not_called()

    def test_remote_gateway_or_other_config_fails_closed(self):
        for replies in ((0, b'"remote"'), (0, b'"local"')):
            calls = iter([replies, (0, b'{"path":"/tmp/other/openclaw.json"}')])
            with self.subTest(replies=replies), patch.object(self.m, 'run_cli', side_effect=lambda *a, **k: next(calls)), \
                 self.assertRaises(Refused):
                self.m.capture()

    def test_config_change_during_probe_and_after_capture_is_detected(self):
        def changing(args, **kwargs):
            reply = self.cli(args, **kwargs)
            if args[0] == 'gateway':
                self.config.write_text('{"fixture":"changed"}')
            return reply
        with patch.object(self.m, 'run_cli', side_effect=changing), self.assertRaises(Refused):
            self.m.capture()
        with patch.object(self.m, 'run_cli', side_effect=self.cli):
            proof = self.m.capture()
            self.config.write_text('{"fixture":"changed-Bgain"}')
            self.assertFalse(self.m.unchanged(proof))

    def test_equal_size_change_has_a_different_digest(self):
        self.config.write_text('{"fixture":"first"}')
        first = self.m._config_id(self.uid, self.gid)
        self.config.write_text('{"fixture":"other"}')
        second = self.m._config_id(self.uid, self.gid)
        self.assertEqual(first[-2], second[-2])
        self.assertNotEqual(first[-1], second[-1])

    def test_symlinked_config_is_not_read_or_used(self):
        self.config.unlink()
        outside = self.root / 'foreign'
        outside.write_text('preserve')
        self.config.symlink_to(outside)
        with patch.object(self.m, 'run_cli') as cli, self.assertRaises(Refused):
            self.m.capture()
        cli.assert_not_called()
        self.assertEqual(outside.read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
