"""System and old native per-user OpenClaw service routing, no real systemd."""
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import state
import cli
from actions import openclaw
from util import Refused


class OpenClawServiceTest(unittest.TestCase):
    def setUp(self):
        jarvis = patch.object(openclaw, 'jarvis_info',
                              return_value={'state': 'active', 'bots': [{'id': 'default', 'working': True}]})
        sleeping = patch.object(openclaw, 'sleep_marks', return_value=set())
        self.jarvis = jarvis.start()
        self.sleeping = sleeping.start()
        self.addCleanup(jarvis.stop)
        self.addCleanup(sleeping.stop)

    def module(self):
        # Lazy import gives a readable RED while the missing module is absent.
        import openclaw_service
        return openclaw_service

    def discover(self, existing):
        service = self.module()
        with patch.object(service.os.path, 'lexists', side_effect=lambda p: p in existing), \
             patch.object(service, 'uid_of', return_value=None):
            return service.discover()

    def test_existing_system_unit_keeps_system_route(self):
        service = self.discover({'/etc/systemd/system/openclaw-gateway.service'})
        self.assertEqual(service, {'unit': 'openclaw-gateway.service', 'scope': 'system'})

    def test_old_user_unit_is_discovered(self):
        service = self.discover({'/home/openclaw/.config/systemd/user/openclaw-gateway.service'})
        self.assertEqual(service, {'unit': 'openclaw-gateway.service', 'scope': 'user'})

    def test_user_manager_finds_unit_even_if_unit_path_is_different(self):
        service = self.module()
        result = types.SimpleNamespace(returncode=0, stdout='loaded\n')
        with patch.object(service.os.path, 'lexists', return_value=False), \
             patch.object(service, 'uid_of', return_value=1234), \
             patch.object(service, 'gid_of', return_value=1235), \
             patch.object(service.subprocess, 'run', return_value=result):
            found = service.discover()
        self.assertEqual(found, {'unit': 'openclaw-gateway.service', 'scope': 'user'})

    def test_simultaneous_system_and_user_units_are_not_guessed(self):
        service = self.discover({'/etc/systemd/system/openclaw-gateway.service',
                                 '/home/openclaw/.config/systemd/user/openclaw-gateway.service'})
        self.assertEqual(service, {'unit': None, 'scope': 'ambiguous'})

    def test_system_unit_kept_if_user_manager_is_inactive_and_no_user_unit_file(self):
        service = self.module()
        existing = {'/etc/systemd/system/openclaw-gateway.service'}
        with patch.object(service.os.path, 'lexists', side_effect=lambda p: p in existing), \
             patch.object(service, 'uid_of', return_value=1234), \
             patch.object(service, '_user_run', return_value=None), \
             patch.object(service, 'systemctl_word', return_value='inactive'):
            result = service.discover()
        self.assertEqual(result, {'unit': 'openclaw-gateway.service', 'scope': 'system'})

    def test_unreachable_active_user_manager_with_system_unit_is_ambiguous(self):
        service = self.module()
        existing = {'/etc/systemd/system/openclaw-gateway.service'}
        with patch.object(service.os.path, 'lexists', side_effect=lambda p: p in existing), \
             patch.object(service, 'uid_of', return_value=1234), \
             patch.object(service, '_user_run', return_value=None), \
             patch.object(service, 'systemctl_word', return_value='active'):
            result = service.discover()
        self.assertEqual(result, {'unit': None, 'scope': 'ambiguous'})

    def test_user_manager_runs_only_as_openclaw_with_its_bus(self):
        service = self.module()
        descriptor = {'unit': 'openclaw-gateway.service', 'scope': 'user'}
        result = types.SimpleNamespace(returncode=0, stdout='active\n')
        with patch.object(service, 'uid_of', return_value=1234), \
             patch.object(service, 'gid_of', return_value=1235), \
             patch.object(service.subprocess, 'run', return_value=result) as run:
            self.assertEqual(service.word(descriptor, 'is-active'), 'active')
        args, kwargs = run.call_args
        self.assertEqual(args[0], ['/usr/bin/systemctl', '--user', 'is-active', 'openclaw-gateway.service'])
        self.assertEqual((kwargs['user'], kwargs['group'], kwargs['extra_groups']), (1234, 1235, ()))
        self.assertEqual(kwargs['env']['XDG_RUNTIME_DIR'], '/run/user/1234')
        self.assertEqual(kwargs['env']['DBUS_SESSION_BUS_ADDRESS'], 'unix:path=/run/user/1234/bus')
        self.assertNotIn('OPENAI_API_KEY', kwargs['env'])

    def test_system_route_uses_existing_systemctl_and_ambiguous_never_executes(self):
        service = self.module()
        with patch.object(service, 'systemctl_ok', return_value=True) as system, \
             patch.object(service.subprocess, 'run') as run:
            self.assertTrue(service.ok({'unit': 'openclaw.service', 'scope': 'system'}, 'stop'))
            self.assertFalse(service.ok({'unit': None, 'scope': 'ambiguous'}, 'stop'))
        system.assert_called_once_with('stop', 'openclaw.service', timeout=60)
        run.assert_not_called()

    def test_missing_user_identity_or_bus_failure_does_not_fabricate_state(self):
        service = self.module()
        descriptor = {'unit': 'openclaw-gateway.service', 'scope': 'user'}
        with patch.object(service, 'uid_of', return_value=None), \
             patch.object(service, 'gid_of', return_value=None), \
             patch.object(service.subprocess, 'run') as run:
            self.assertEqual(service.word(descriptor, 'is-active'), '')
            self.assertFalse(service.ok(descriptor, 'start'))
        run.assert_not_called()

    def test_user_service_never_runs_with_root_uid(self):
        service = self.module()
        with patch.object(service, 'uid_of', return_value=0), \
             patch.object(service, 'gid_of', return_value=0), \
             patch.object(service.subprocess, 'run') as run:
            self.assertEqual(service.word({'unit': 'openclaw-gateway.service', 'scope': 'user'}, 'is-active'), '')
        run.assert_not_called()

    def test_state_reads_same_selected_user_target(self):
        descriptor = {'unit': 'openclaw-gateway.service', 'scope': 'user'}
        with patch.object(state, 'discover_oc_service', return_value=descriptor), \
             patch.object(state.os.path, 'lexists', return_value=False), \
             patch.object(state.os.path, 'isdir', return_value=True), \
             patch.object(state, 'oc_service_word', return_value='active') as word:
            result = state.openclaw_info()
        self.assertEqual((result['unit'], result['scope'], result['gateway']),
                         ('openclaw-gateway.service', 'user', 'active'))
        word.assert_called_once_with(descriptor, 'is-active')

    def test_unknown_manager_without_other_evidence_is_not_reported_absent(self):
        descriptor = {'unit': None, 'scope': 'unknown'}
        with patch.object(state, 'discover_oc_service', return_value=descriptor), \
             patch.object(state.os.path, 'lexists', return_value=False), \
             patch.object(state.os.path, 'isdir', return_value=False):
            result = state.openclaw_info()
        self.assertIsNone(result['installed'])
        self.assertEqual(result['gateway'], 'unknown')

    def test_ambiguous_units_have_no_guessed_enabled_state_or_actions(self):
        descriptor = {'unit': None, 'scope': 'ambiguous'}
        with patch.object(state, 'discover_oc_service', return_value=descriptor), \
             patch.object(state.os.path, 'lexists', return_value=False), \
             patch.object(state.os.path, 'isdir', return_value=False):
            result = state.openclaw_info()
        self.assertTrue(result['installed'])
        self.assertIsNone(result['enabled'])
        self.assertIsNone(result['incomplete'])
        actions = state.available_actions({'installed': False}, result)
        self.assertEqual(actions['client'], ['status'])

    def test_off_marker_does_not_hide_a_still_active_gateway(self):
        descriptor = {'unit': 'openclaw.service', 'scope': 'system'}
        with patch.object(state, 'discover_oc_service', return_value=descriptor), \
             patch.object(state.os.path, 'lexists', return_value=True), \
             patch.object(state, 'oc_service_word', return_value='active'):
            result = state.openclaw_info()
        self.assertFalse(result['enabled'])
        self.assertEqual(result['gateway'], 'active')

    def test_stop_uses_selected_target_and_confirms_inactive(self):
        info = {'installed': True, 'enabled': True, 'unit': 'openclaw-gateway.service', 'scope': 'user'}
        with patch.object(openclaw, 'openclaw_info', return_value=info), \
             patch.object(openclaw, 'ensure_root_dir'), patch.object(openclaw, 'write_file'), \
             patch.object(openclaw, 'oc_service_ok', return_value=True) as run, \
             patch.object(openclaw, 'wait_stopped', return_value='inactive') as wait:
            result = openclaw.act_disable_openclaw('client', {'params': {}}, lambda *_: None)
        descriptor = {'unit': info['unit'], 'scope': 'user'}
        run.assert_called_once_with(descriptor, 'disable', '--now', '--no-block', timeout=30)
        wait.assert_called_once_with(descriptor)
        self.assertEqual(result['gateway'], 'inactive')

    def test_unknown_target_does_not_write_off_marker(self):
        info = {'installed': True, 'enabled': True, 'unit': None, 'scope': 'ambiguous'}
        with patch.object(openclaw, 'openclaw_info', return_value=info), \
             patch.object(openclaw, 'write_file') as write:
            with self.assertRaises(Refused) as refused:
                openclaw.act_disable_openclaw('client', {'params': {}}, lambda *_: None)
        self.assertEqual(refused.exception.code, 'NOT_AVAILABLE')
        write.assert_not_called()

    def test_failed_stop_or_still_running_is_not_reported_as_inactive(self):
        info = {'installed': True, 'enabled': True, 'unit': 'openclaw.service', 'scope': 'system'}
        for ok, observed, reason in ((False, None, 'OC_STOP'), (True, None, 'OC_STILL_ACTIVE')):
            with self.subTest(ok=ok, observed=observed), \
                 patch.object(openclaw, 'openclaw_info', return_value=info), \
                 patch.object(openclaw, 'ensure_root_dir'), patch.object(openclaw, 'write_file'), \
                 patch.object(openclaw, 'oc_service_ok', return_value=ok), \
                 patch.object(openclaw, 'wait_stopped', return_value=observed):
                with self.assertRaises(Refused) as refused:
                    openclaw.act_disable_openclaw('client', {'params': {}}, lambda *_: None)
                self.assertEqual(refused.exception.detail['reason'], reason)

    def test_off_marker_survives_missing_target_and_failed_start(self):
        with tempfile.TemporaryDirectory() as root:
            marker = Path(root) / 'openclaw.off'
            for unit in (None, 'openclaw.service'):
                marker.write_bytes(b'off')
                info = {'installed': True, 'enabled': False, 'unit': unit, 'scope': 'system'}
                with self.subTest(unit=unit), patch.object(openclaw, 'OC_OFF', str(marker)), \
                     patch.object(openclaw, 'openclaw_info', return_value=info), \
                     patch.object(openclaw, 'oc_service_ok', return_value=False):
                    with self.assertRaises(Refused):
                        openclaw.act_enable_openclaw('client', {'params': {}}, lambda *_: None)
                    self.assertEqual(marker.read_bytes(), b'off')

    def test_off_marker_is_cleared_only_after_confirmed_start(self):
        with tempfile.TemporaryDirectory() as root:
            marker = Path(root) / 'openclaw.off'
            marker.write_bytes(b'off')
            info = {'installed': True, 'enabled': False, 'unit': 'openclaw.service', 'scope': 'system'}
            with patch.object(openclaw, 'OC_OFF', str(marker)), \
                 patch.object(openclaw, 'openclaw_info', return_value=info), \
                 patch.object(openclaw, 'oc_service_ok', return_value=True), \
                 patch.object(openclaw, 'oc_service_word', return_value='active'):
                result = openclaw.act_enable_openclaw('client', {'params': {}}, lambda *_: None)
            self.assertEqual(result['gateway'], 'active')
            self.assertFalse(marker.exists())

    def test_failed_stop_can_be_retried_when_off_marker_exists_but_gateway_runs(self):
        info = {'installed': True, 'enabled': False, 'gateway': 'active',
                'unit': 'openclaw.service', 'scope': 'system'}
        with patch.object(openclaw, 'openclaw_info', return_value=info), \
             patch.object(openclaw, 'ensure_root_dir'), patch.object(openclaw, 'write_file'), \
             patch.object(openclaw, 'oc_service_ok', return_value=True) as run, \
             patch.object(openclaw, 'wait_stopped', return_value='inactive'):
            result = openclaw.act_disable_openclaw('client', {'params': {}}, lambda *_: None)
        self.assertEqual(result['gateway'], 'inactive')
        run.assert_called_once()

    def test_refuses_to_stop_last_working_engine_before_any_change(self):
        self.jarvis.return_value = {'state': 'inactive', 'bots': [{'id': 'default', 'working': False}]}
        info = {'installed': True, 'enabled': True, 'gateway': 'active',
                'unit': 'openclaw.service', 'scope': 'system'}
        with patch.object(openclaw, 'openclaw_info', return_value=info), \
             patch.object(openclaw, 'write_file') as write, \
             patch.object(openclaw, 'oc_service_ok') as run:
            with self.assertRaises(Refused) as refused:
                openclaw.act_disable_openclaw('client', {'params': {}}, lambda *_: None)
        self.assertEqual(refused.exception.code, 'LAST_ENGINE')
        self.assertIn('LAST_ENGINE', state.CODES)
        write.assert_not_called()
        run.assert_not_called()

    def test_stop_attempt_wakes_sleeping_bots_even_when_service_fails(self):
        self.sleeping.return_value = {'second', 'third'}
        info = {'installed': True, 'enabled': True, 'gateway': 'active',
                'unit': 'openclaw.service', 'scope': 'system'}
        with patch.object(openclaw, 'openclaw_info', return_value=info), \
             patch.object(openclaw, 'ensure_root_dir'), patch.object(openclaw, 'write_file'), \
             patch.object(openclaw, 'oc_service_ok', return_value=False), \
             patch.object(openclaw, 'set_sleep') as wake:
            with self.assertRaises(Refused):
                openclaw.act_disable_openclaw('client', {'id': 'synthetic-id', 'params': {}}, lambda *_: None)
        wake.assert_called_once_with(['second', 'third'], False, 'synthetic-id')

    def test_stop_waits_through_gateway_drain_and_fails_on_unknown(self):
        service = self.module()
        descriptor = {'unit': 'openclaw.service', 'scope': 'system'}
        with patch.object(service, 'word', side_effect=['active', 'deactivating', 'inactive']), \
             patch.object(service.time, 'monotonic', side_effect=[0, 1, 2]), \
             patch.object(service.time, 'sleep') as sleep:
            self.assertEqual(service.wait_stopped(descriptor, timeout=10), 'inactive')
            self.assertEqual(sleep.call_count, 2)
        with patch.object(service, 'word', return_value=''), \
             patch.object(service.time, 'monotonic', return_value=0):
            self.assertIsNone(service.wait_stopped(descriptor, timeout=10))

    def test_tick_uses_same_target_and_respects_transitions_and_off_marker(self):
        service = self.module()
        info = {'installed': True, 'enabled': True, 'unit': 'openclaw-gateway.service', 'scope': 'user'}
        target = {'unit': info['unit'], 'scope': 'user'}
        for observed, off, should_start in (('inactive', False, True), ('failed', False, True),
                                            ('active', False, False), ('activating', False, False),
                                            ('', False, False), ('inactive', True, False)):
            with self.subTest(observed=observed, off=off), \
                 patch.object(cli, 'need_root'), patch.object(cli, 'locked', return_value=999), \
                 patch.object(cli, 'ensure_run_dirs'), patch.object(cli, 'cleanup_claims'), \
                 patch.object(cli, 'uid_of', return_value=None), patch.object(cli, 'write_state'), \
                 patch.object(cli, 'compute_state', return_value={}), patch.object(cli.os, 'close'), \
                 patch.object(state, 'bot_ids', return_value=[]), patch.object(state, 'sleep_marks', return_value=set()), \
                 patch.object(state, 'openclaw_info', return_value=info), \
                 patch.object(cli.os.path, 'lexists', return_value=off), \
                 patch.object(service, 'word', return_value=observed), \
                 patch.object(service, 'ok', return_value=True) as start:
                self.assertEqual(cli.cmd_tick([]), 0)
                if should_start and observed == 'failed':
                    self.assertEqual(start.call_args_list, [unittest.mock.call(target, 'reset-failed'),
                                                            unittest.mock.call(target, 'start')])
                elif should_start:
                    start.assert_called_once_with(target, 'start')
                else:
                    start.assert_not_called()

    def test_tick_retries_failed_wake_without_restarting_off_openclaw(self):
        from actions import bots
        service = self.module()
        info = {'installed': True, 'enabled': False, 'unit': 'openclaw.service', 'scope': 'system'}
        with patch.object(cli, 'need_root'), patch.object(cli, 'locked', return_value=999), \
             patch.object(cli, 'ensure_run_dirs'), patch.object(cli, 'cleanup_claims'), \
             patch.object(cli, 'uid_of', return_value=None), patch.object(cli, 'write_state'), \
             patch.object(cli, 'compute_state', return_value={}), patch.object(cli.os, 'close'), \
             patch.object(state, 'bot_ids', return_value=[]), patch.object(state, 'sleep_marks', return_value={'second'}), \
             patch.object(state, 'openclaw_info', return_value=info), \
             patch.object(cli.os.path, 'lexists', return_value=True), \
             patch.object(service, 'ok') as start, patch.object(bots, 'set_sleep') as wake:
            self.assertEqual(cli.cmd_tick([]), 0)
        wake.assert_called_once_with(['second'], False, 'tick')
        start.assert_not_called()


if __name__ == '__main__':
    unittest.main()
