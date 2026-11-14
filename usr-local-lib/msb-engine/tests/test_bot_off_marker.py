"""Bot off-marker lifecycle via the real dispatcher and synthetic systemd state.

All markers and bot directories are temporary. No host services are started.
Old reference: 00f081f:usr-local-sbin/jarvis-engine lines 2857-2869,
2899-2913 and 3250-3269.
"""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cli
import state
import util
from actions import bots


class BotOffMarkerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.marks = self.root / 'marks'
        self.marks.mkdir()
        self.units = {}
        self.calls = []
        for bot in ('default', 'other'):
            (self.root / 'bots' / bot).mkdir(parents=True)
            self.marker(bot).write_text('off')
            self.units[state.bot_unit(bot)] = {'enabled': 'masked', 'active': False, 'fail': False}

        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(state, 'CLIENT_ROOT', str(self.root)))
        stack.enter_context(patch.object(state, 'MARKS_DIR', str(self.marks)))
        stack.enter_context(patch.object(state, 'msb_present', return_value=True))
        stack.enter_context(patch.object(state, 'sleep_marks', return_value=set()))
        stack.enter_context(patch.object(state, 'cc_cli_version', return_value=None))
        stack.enter_context(patch.object(state, 'systemctl_word', side_effect=self.systemctl_word))
        stack.enter_context(patch.object(bots, 'sleep_marks', return_value=set()))
        stack.enter_context(patch.object(bots, 'systemctl_ok', side_effect=self.systemctl_ok))
        stack.enter_context(patch.object(cli, 'spend', return_value=None))
        stack.enter_context(patch.object(cli, 'compute_state', side_effect=lambda: {'jarvis': state.jarvis_info()}))
        self.saved = stack.enter_context(patch.object(cli, 'write_state'))
        self.results = stack.enter_context(patch.object(cli, 'write_result'))

    def marker(self, bot):
        return self.root / 'marks' / f'{bot}.off'

    def systemctl_word(self, action, unit, **_kwargs):
        info = self.units[unit]
        if action == 'is-enabled':
            return info['enabled']
        if action == 'is-active':
            return 'active' if info['active'] else 'inactive'
        if action == 'is-failed':
            return 'inactive'
        raise AssertionError(f'unexpected systemctl query: {action}')

    def systemctl_ok(self, *args, **_kwargs):
        self.calls.append(args)
        unit = args[-1]
        info = self.units[unit]
        if args[0] == 'unmask':
            info['enabled'] = 'disabled'
            return True
        if args[:2] == ('enable', '--now'):
            bot = unit.split('@', 1)[1].removesuffix('.service')
            if bot in ('default', 'other') and not info.get('no_marker'):
                self.assertTrue(self.marker(bot).is_file(), 'off is retained until startup succeeds')
            info['enabled'] = 'enabled'
            info['active'] = not info['fail']
            return not info['fail']
        if args[0] == 'start':
            info['active'] = True
            return True
        if args[0] == 'reset-failed':
            return True
        raise AssertionError(f'unexpected systemctl command: {args}')

    def enable(self, bot=None):
        request = {'v': 1, 'id': 'fixture-request', 'action': 'enable-msb'}
        if bot is not None:
            request['bot_id'] = bot
        cli.handle('client', json.dumps(request).encode())
        return self.results.call_args.args

    def reported(self, bot):
        snapshot = self.saved.call_args.args[0]['jarvis']
        return next(row for row in snapshot['bots'] if row['id'] == bot)

    def test_success_clears_only_the_selected_bot_after_start(self):
        result = self.enable('default')
        self.assertEqual(result[3:5], ('done', 'OK'))
        self.assertFalse(self.marker('default').exists())
        self.assertTrue(self.marker('other').exists())
        self.assertEqual(result[6]['started'], ['default'])
        self.assertTrue(self.reported('default')['enabled'])
        self.assertTrue(self.reported('default')['working'])
        self.assertFalse(self.reported('other')['enabled'])
        self.assertTrue(all('other' not in ' '.join(call) for call in self.calls))

    def test_status_and_available_actions_follow_the_successful_start(self):
        (self.root / 'bots' / 'other').rmdir()
        result = self.enable('default')
        self.assertEqual(result[3:5], ('done', 'OK'))
        snapshot = self.saved.call_args.args[0]['jarvis']
        self.assertEqual(snapshot['state'], 'active')
        actions = state.available_actions(snapshot, {'installed': False})['client']
        self.assertNotIn('enable-msb', actions)
        self.assertIn('disable-msb', actions)

    def test_failed_start_preserves_marker_and_reports_failure(self):
        self.units[state.bot_unit('default')]['fail'] = True
        result = self.enable('default')
        self.assertEqual(result[3:5], ('failed', 'FAILED'))
        self.assertEqual(result[6]['reason'], 'MSB_START')
        self.assertTrue(self.marker('default').exists())
        self.assertFalse(self.reported('default')['enabled'])
        self.assertFalse(self.reported('default')['working'])
        self.assertTrue(self.marker('other').exists())

    def test_partial_failure_clears_only_successful_bots(self):
        self.units[state.bot_unit('default')]['fail'] = True
        result = self.enable()
        self.assertEqual(result[3:5], ('failed', 'FAILED'))
        self.assertTrue(self.marker('default').exists())
        self.assertFalse(self.marker('other').exists())
        self.assertFalse(self.reported('default')['enabled'])
        self.assertTrue(self.reported('other')['working'])

    def test_masked_bot_without_off_marker_can_be_started(self):
        self.marker('default').unlink()
        self.units[state.bot_unit('default')]['no_marker'] = True
        result = self.enable('default')
        self.assertEqual(result[3:5], ('done', 'OK'))
        self.assertTrue(self.reported('default')['working'])
        self.assertTrue(self.marker('other').exists())

    def test_success_unlinks_the_marker_symlink_without_touching_its_target(self):
        self.marker('default').unlink()
        target = self.root / 'unrelated-file'
        target.write_text('preserve')
        self.marker('default').symlink_to(target)
        result = self.enable('default')
        self.assertEqual(result[3:5], ('done', 'OK'))
        self.assertFalse(self.marker('default').is_symlink())
        self.assertEqual(target.read_text(), 'preserve')
        self.assertTrue(self.reported('default')['working'])

    def test_failure_to_remove_marker_cannot_report_success(self):
        unlink = os.unlink

        def fail_marker(file, *args, **kwargs):
            if str(file) == str(self.marker('default')):
                raise PermissionError('synthetic refusal')
            return unlink(file, *args, **kwargs)

        with patch.object(os, 'unlink', side_effect=fail_marker):
            result = self.enable('default')
        self.assertEqual(result[3:5], ('failed', 'FAILED'))
        self.assertEqual(result[6]['reason'], 'INTERNAL_PERMISSIONERROR')
        self.assertTrue(self.marker('default').exists())
        self.assertFalse(self.reported('default')['enabled'])

    def test_waking_a_sleeping_bot_does_not_start_the_service(self):
        self.marker('default').unlink()
        self.units[state.bot_unit('default')].update(enabled='enabled', active=True)
        with patch.object(state, 'sleep_marks', return_value={'default'}), \
             patch.object(bots, 'sleep_marks', return_value={'default'}), \
             patch.object(bots, 'set_sleep') as wake:
            result = self.enable('default')
        self.assertEqual(result[3:5], ('done', 'OK'))
        self.assertEqual(result[6]['woken'], ['default'])
        self.assertEqual(result[6]['started'], [])
        wake.assert_called_once_with(['default'], False, 'fixture-request')
        self.assertEqual(self.calls, [])

    def test_removed_bot_is_not_started_or_unmarked(self):
        removed = self.marks / 'default.removed'
        removed.write_text('removed')
        result = self.enable('default')
        self.assertEqual(result[3:5], ('refused', 'NOT_INSTALLED'))
        self.assertTrue(removed.exists())
        self.assertTrue(self.marker('default').exists())
        self.assertEqual(self.calls, [])

    def test_tick_does_not_restart_a_bot_with_an_off_marker(self):
        self.marker('other').unlink()
        for info in self.units.values():
            info['enabled'] = 'enabled'
        lock = os.open(str(self.root), os.O_RDONLY)
        with patch.object(cli, 'need_root'), patch.object(cli, 'locked', return_value=lock), \
             patch.object(cli, 'ensure_run_dirs'), patch.object(cli, 'SOURCES', ()), \
             patch.object(cli, 'log'), patch.object(util, 'systemctl_word', side_effect=self.systemctl_word), \
             patch.object(util, 'systemctl_ok', side_effect=self.systemctl_ok), \
             patch.object(state, 'openclaw_info', return_value={'installed': False}), \
             patch.object(state, 'openclaw_off_paths', return_value=[]):
            self.assertEqual(cli.cmd_tick(None), 0)
        started = [call[-1] for call in self.calls if call[0] == 'start']
        self.assertEqual(started, [state.bot_unit('other')])
        self.assertFalse(self.reported('default')['working'])
        self.assertTrue(self.reported('other')['working'])


if __name__ == '__main__':
    unittest.main()
