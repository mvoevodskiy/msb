"""Pult requests through the real parser/dispatcher with isolated bot env files.

No systemd, host secrets, generated Pult files or real bot profiles are touched.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cli
from actions import pult


class PultRoutingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pult = self.root / 'pult'
        (self.pult / 'deploy').mkdir(parents=True)
        (self.pult / 'deploy' / 'secrets.sh').write_text('# fixture\n')
        self.envs = {}
        for bot, owner, port in [('default', '111', '8701'), ('second_bot', '222', '8702')]:
            directory = self.root / 'bots' / bot
            directory.mkdir(parents=True)
            env = directory / '.env'
            env.write_text(
                f'PULT_PASSWORD=fixture-{bot}-password\n'
                f'PULT_PUBLIC_URL=https://{bot}.invalid\n'
                f'PULT_PORT={port}\nADMIN_ID={owner}\n'
            )
            self.envs[bot] = env.read_bytes()

    def dispatch(self, action, bot_id=None, active=False):
        request = {'v': 1, 'id': 'pultfixture01', 'action': action}
        if bot_id is not None:
            request['bot_id'] = bot_id
        info = {'installed': True, 'enabled': active, 'active': active}
        with patch.dict(os.environ, {}, clear=True), \
             patch.multiple(pult, CLIENT_ROOT=str(self.root), PULT_ROOT=str(self.pult),
                            PULT_SECRETS=str(self.root / 'pult-secrets'),
                            PULT_OFF=str(self.root / 'pult.off')), \
             patch.object(pult, 'pult_info', return_value=info), \
             patch.object(pult, 'systemctl_ok', return_value=True) as systemctl, \
             patch.object(pult, 'systemctl_word', return_value='active'), \
             patch.object(pult.subprocess, 'run') as secrets, \
             patch.object(cli, 'spend', return_value=None), \
             patch.object(cli, 'write_state'), patch.object(cli, 'compute_state', return_value={}), \
             patch.object(cli, 'write_result') as results:
            cli.handle('client', json.dumps(request).encode())
            return secrets.call_args, systemctl.call_args_list, results.call_args_list

    def test_enable_and_reload_use_requested_bot_or_default(self):
        for action, active in [('enable-pult', False), ('reload-pult', False), ('reload-pult', True)]:
            for bot_id, expected, owner, port in [
                (None, 'default', '111', '8701'),
                ('default', 'default', '111', '8701'),
                ('second_bot', 'second_bot', '222', '8702'),
            ]:
                with self.subTest(action=action, active=active, bot_id=bot_id):
                    call, systemctl, results = self.dispatch(action, bot_id, active)
                    self.assertIsNotNone(call, 'the existing secret writer must run')
                    env = call.kwargs['env']
                    self.assertEqual(env['PULT_PASSWORD'], f'fixture-{expected}-password')
                    self.assertEqual(env['ADMIN_ID'], owner)
                    self.assertEqual(call.args[0][-4:], [
                        '--public-url', f'https://{expected}.invalid', '--port', port,
                    ])
                    self.assertEqual(results[-1].args[3:5], ('done', 'OK'))
                    self.assertEqual(results[-1].args[7], bot_id)
                    self.assertEqual(bool(systemctl), action == 'enable-pult' or active)
        for bot, original in self.envs.items():
            self.assertEqual((self.root / 'bots' / bot / '.env').read_bytes(), original)

    def test_invalid_bot_id_is_refused_before_any_pult_action(self):
        call, systemctl, results = self.dispatch('reload-pult', '../default')
        self.assertIsNone(call)
        self.assertEqual(systemctl, [])
        self.assertEqual(results[-1].args[3:5], ('refused', 'BAD_REQUEST'))

    def test_missing_selected_bot_does_not_borrow_default_credentials(self):
        call, systemctl, results = self.dispatch('reload-pult', 'missing_bot')
        self.assertIsNone(call)
        self.assertEqual(systemctl, [])
        self.assertEqual(results[-1].args[3:5], ('refused', 'NOT_AVAILABLE'))
        self.assertEqual(results[-1].args[6]['reason'], 'NO_PULT_PASSWORD')


if __name__ == '__main__':
    unittest.main()
