"""Old inverse switch: do not sleep a bot unless OpenClaw is confirmed ready."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import state
import cli
from actions import bots
from util import Refused

IID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'


class ReadinessTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        self.marker = self.root / 'openclaw.installed'
        self.setup = self.root / 'openclaw.setup'
        self.legacy_marker = self.root / 'legacy' / 'openclaw.installed'
        self.legacy_setup = self.root / 'legacy' / 'openclaw.setup'
        self.off = self.root / 'openclaw.off'
        self.legacy_off = self.root / 'legacy' / 'openclaw.off'

    def status(self, scope='system'):
        target = {'unit': 'openclaw.service', 'scope': scope}
        with patch.object(state, 'OC_MARKER', str(self.marker)), \
             patch.object(state, 'OC_SETUP', str(self.setup), create=True), \
             patch.object(state, 'LEGACY_OC_MARKER', str(self.legacy_marker)), \
             patch.object(state, 'OC_OFF', str(self.off)), \
             patch.object(state, 'LEGACY_OC_OFF', str(self.legacy_off)), \
             patch.object(state, 'OC_HOME', str(self.root)), \
             patch.object(state, 'discover_oc_service', return_value=target), \
             patch.object(state, 'oc_service_word', return_value='active'):
            return state.openclaw_info()

    def test_unrecorded_active_service_has_unknown_setup_not_false_success(self):
        self.assertIsNone(self.status()['incomplete'])

    def test_old_complete_marker_and_no_setup_record_are_configured(self):
        self.marker.write_text(f'complete=1\ninstallation_id={IID}\n')
        self.assertIs(self.status()['incomplete'], False)

    def test_matching_unfinished_setup_is_incomplete(self):
        self.marker.write_text(f'complete=1\ninstallation_id={IID}\n')
        self.setup.write_text(f'installation_id={IID}\nconfigured=0\n')
        self.assertIs(self.status()['incomplete'], True)
        self.setup.write_text(f'installation_id={IID}\nconfigured=1\n')
        self.assertIs(self.status()['incomplete'], False)

    def test_legacy_marker_is_not_assumed_to_identify_another_installation(self):
        self.legacy_marker.parent.mkdir()
        self.legacy_marker.write_text(f'complete=1\ninstallation_id={IID}\n')
        self.legacy_setup.write_text(f'installation_id={IID}\nconfigured=1\n')
        self.assertIsNone(self.status('system')['incomplete'])
        self.assertIsNone(self.status('user')['incomplete'])
        self.marker.write_text('not-a-marker')
        self.assertIsNone(self.status()['incomplete'], 'an invalid new marker must not fall back')

    def test_old_off_intent_applies_only_to_user_unit_even_with_new_marker(self):
        self.legacy_marker.parent.mkdir()
        self.legacy_off.write_text('off')
        self.assertFalse(self.status('user')['enabled'])
        self.assertTrue(self.status('system')['enabled'])
        self.marker.write_text(f'complete=1\ninstallation_id={IID}\n')
        self.assertFalse(self.status('user')['enabled'])
        self.marker.write_text('invalid')
        self.assertFalse(self.status('user')['enabled'])

    def test_malformed_or_other_setup_record_is_unknown(self):
        self.marker.write_text(f'complete=1\ninstallation_id={IID}\n')
        for content in ('configured=0\n', f'installation_id={IID}\nconfigured=maybe\n',
                        'installation_id=bbbbbbbb-cccc-dddd-eeee-ffffffffffff\nconfigured=1\n'):
            with self.subTest(content=content):
                self.setup.write_text(content)
                self.assertIsNone(self.status()['incomplete'])

    def test_incomplete_install_or_untrusted_marker_never_proves_readiness(self):
        self.marker.write_text(f'complete=0\ninstallation_id={IID}\n')
        self.assertIs(self.status()['incomplete'], True)
        self.marker.unlink()
        target = self.root / 'target'
        target.write_text('complete=1\n')
        self.marker.symlink_to(target)
        self.assertIsNone(self.status()['incomplete'])


class SwitchSafetyTest(unittest.TestCase):
    def setUp(self):
        self.req = {'id': 'synthetic-id', 'params': {'bot_id': 'default'}}
        self.jarvis = {'installed': True, 'state': 'active', 'bots': [
            {'id': 'default', 'removed': False, 'enabled': True, 'sleeping': False},
            {'id': 'other', 'removed': False, 'enabled': True, 'sleeping': False},
        ]}
        self.ready = {'installed': True, 'enabled': True, 'incomplete': False, 'gateway': 'active'}

    def test_every_unready_state_refuses_before_writing_sleep_marker(self):
        for override in ({'installed': False}, {'enabled': False}, {'incomplete': True},
                         {'incomplete': None}, {'gateway': 'inactive'}, {'gateway': 'unknown'}):
            with self.subTest(override=override), \
                 patch.object(bots, 'jarvis_info', return_value=self.jarvis), \
                 patch.object(bots, 'openclaw_info', return_value={**self.ready, **override}, create=True), \
                 patch.object(bots, 'set_sleep') as write:
                with self.assertRaises(Refused) as refused:
                    bots.act_disable_jarvis('client', self.req, lambda *_: None)
                self.assertEqual(refused.exception.code, 'LAST_ENGINE')
                write.assert_not_called()

    def test_confirmed_openclaw_sleeps_only_selected_bot(self):
        with patch.object(bots, 'jarvis_info', return_value=self.jarvis), \
             patch.object(bots, 'openclaw_info', return_value=self.ready, create=True), \
             patch.object(bots, 'set_sleep') as write, \
             patch.object(bots, 'systemctl_word', return_value='active'):
            result = bots.act_disable_jarvis('client', self.req, lambda *_: None)
        write.assert_called_once_with(['default'], True, 'synthetic-id')
        self.assertEqual(result['bots'], ['default'])

    def test_existing_disabled_and_missing_results_remain_unchanged(self):
        missing = {'installed': False, 'state': 'absent', 'bots': []}
        with patch.object(bots, 'jarvis_info', return_value=missing):
            with self.assertRaises(Refused) as refused:
                bots.act_disable_jarvis('client', self.req, lambda *_: None)
        self.assertEqual(refused.exception.code, 'NOT_INSTALLED')
        sleeping = {**self.jarvis, 'bots': [{**self.jarvis['bots'][0], 'sleeping': True}]}
        with patch.object(bots, 'jarvis_info', return_value=sleeping):
            with self.assertRaises(Refused) as refused:
                bots.act_disable_jarvis('client', self.req, lambda *_: None)
        self.assertEqual(refused.exception.code, 'ALREADY_DISABLED')

    def test_dispatcher_preserves_last_engine_reason_in_result(self):
        payload = b'{"v":1,"id":"abcdefgh","action":"disable-msb","bot_id":"default"}'
        with patch.object(bots, 'jarvis_info', return_value=self.jarvis), \
             patch.object(bots, 'openclaw_info', return_value={**self.ready, 'incomplete': None}), \
             patch.object(cli, 'spend', return_value=None), patch.object(cli, 'write_result') as result, \
             patch.object(cli, 'compute_state', return_value={}), patch.object(cli, 'write_state'):
            cli.handle('client', payload)
        last = result.call_args_list[-1]
        self.assertEqual(last.args[:5], ('client', 'abcdefgh', 'disable-msb', 'refused', 'LAST_ENGINE'))
        self.assertEqual(last.args[6], {'other': 'unknown'})


if __name__ == '__main__':
    unittest.main()
