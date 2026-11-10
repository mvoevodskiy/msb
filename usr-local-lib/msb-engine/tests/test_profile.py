"""Namespace routing only: no systemd calls, host files or real credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


ENGINE = Path(__file__).resolve().parents[1]
PROBE = r'''
import json
import sys
from unittest.mock import mock_open, patch
sys.path.insert(0, sys.argv[1])
import const
import state
from actions import pult

namespace = sys.argv[2]
root = '/home/client/.' + namespace
assert const.CLIENT_ROOT == root
assert const.SOURCES[0] == ('client', root + '/engine', 'client')
assert const.SOURCES[1] == ('openclaw', '/home/openclaw/.msb-engine', 'openclaw')
assert const.BOT_UNIT_TMPL == namespace + '-bot@%s.service'
assert const.BOT_TEMPLATE == '/etc/systemd/system/' + namespace + '-bot@.service'
assert state.bot_unit('default') == namespace + '-bot@default.service'
assert const.RUN_DIR == '/run/msb-engine'
assert const.STATE_DIR == '/var/lib/msb-engine'

with patch('state.os.listdir', return_value=['default', 'bad/name']) as listing, \
     patch('state.os.path.isdir', return_value=True):
    assert state.bot_ids() == ['default']
    listing.assert_called_once_with(root + '/bots')
with patch('state.os.path.lexists', return_value=True) as exists:
    assert state.msb_present()
    exists.assert_called_once_with(const.BOT_TEMPLATE)

assert pult.PULT_ROOT == root + '/pult'
env_path = root + '/bots/default/.env'
assert pult._bot_env_path('default') == env_path
with patch('actions.pult.os.path.isfile', side_effect=lambda p: p == env_path), \
     patch('builtins.open', mock_open(read_data='PULT_PASSWORD=synthetic-test-password\nADMIN_ID=42\n')) as opened:
    values = pult._load_bot_env('default')
    assert values['PULT_PASSWORD'] == 'synthetic-test-password'
    assert values['ADMIN_ID'] == '42'
    opened.assert_called_once_with(env_path, 'r', encoding='utf-8')

present = {root + '/pult/package.json', '/etc/systemd/system/pult-web.service'}
with patch('state.os.path.isfile', side_effect=lambda p: p in present), \
     patch('state.os.path.lexists', return_value=False), \
     patch('state.systemctl_word', side_effect=lambda op, unit: 'active' if op == 'is-active' else 'enabled'):
    info = state.pult_info()
assert info['installed'] and info['enabled'] and info['active']
assert info['root'] == root + '/pult'
print(json.dumps({'profile': const.RUNTIME_PROFILE, 'root': root}))
'''


class ProfileRoutingTest(unittest.TestCase):
    def probe(self, profile, namespace):
        env = {'PATH': os.defpath}
        if profile is not None:
            env['MSB_RUNTIME_PROFILE'] = profile
        result = subprocess.run(
            [sys.executable, '-BIS', '-c', PROBE, str(ENGINE), namespace],
            env=env, text=True, capture_output=True, check=True,
        )
        self.assertEqual(json.loads(result.stdout), {
            'profile': profile or 'msb', 'root': '/home/client/.' + namespace,
        })

    def test_default_msb_routes_are_unchanged(self):
        self.probe(None, 'msb')

    def test_explicit_msb_routes_are_unchanged(self):
        self.probe('msb', 'msb')

    def test_jar1_routes_requests_bots_pult_and_env_to_iia(self):
        self.probe('jar1', 'iia')

    def test_unknown_profile_is_rejected_before_routing(self):
        result = subprocess.run(
            [sys.executable, '-BIS', '-c', PROBE, str(ENGINE), 'msb'],
            env={'PATH': os.defpath, 'MSB_RUNTIME_PROFILE': 'unknown'},
            text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('MSB_RUNTIME_PROFILE must be msb or jar1', result.stderr)


if __name__ == '__main__':
    unittest.main()
