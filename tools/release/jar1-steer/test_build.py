"""Release selection must reject unplanned runtime changes before export."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_builder', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildScopeTest(unittest.TestCase):
    def test_history_is_in_the_exact_fourteen_file_bot_scope(self):
        history = 'src/telegram/history.mjs'
        self.assertEqual(len(build.BOT), 14)
        self.assertEqual(len(set(build.BOT)), 14)
        self.assertEqual(build.BOT.count(history), 1)
        self.assertLess(build.BOT.index(history), build.BOT.index('src/telegram/bot.mjs'))
        deploy_spec = importlib.util.spec_from_file_location('release_deployer', Path(__file__).with_name('deploy.py'))
        deploy = importlib.util.module_from_spec(deploy_spec)
        deploy_spec.loader.exec_module(deploy)
        self.assertEqual([name for root, name in deploy.RELEASE_ORDER if root == 'bot'], list(build.BOT))
        self.assertNotIn(('bot', history), deploy.ADDED)
        self.assertEqual(len(deploy.ADDED), 6)

    def test_foreign_baseline_is_rejected_before_stage_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            def fake_git(_repo, *args):
                if args[0] == 'rev-parse': return b'a' * 40 + b'\n'
                if args[0] == 'merge-base': return b'b' * 40 + b'\n'
                raise AssertionError(args)
            target = Path(tmp) / 'stage'
            with patch.object(build, 'git', side_effect=fake_git):
                with self.assertRaisesRegex(ValueError, 'baseline'): build.build(tmp, 'candidate', target)
            self.assertFalse(target.exists())

    def test_unplanned_runtime_changes_are_rejected(self):
        for unexpected in ('.msb/bot/shared/unexpected.mjs', '.msb/puller.cjs',
                           'overlay/bot/ext/extra.mjs', '.msb/bot/package-lock.json'):
            with self.subTest(path=unexpected), tempfile.TemporaryDirectory() as tmp:
                def fake_git(_repo, *args):
                    if args[0] == 'rev-parse': return b'a' * 40 + b'\n'
                    if args[0] == 'merge-base': return build.BASE.encode() + b'\n'
                    if args[0] == 'diff': return (unexpected + '\n').encode()
                    raise AssertionError(args)
                target = Path(tmp) / 'stage'
                with patch.object(build, 'git', side_effect=fake_git):
                    with self.assertRaisesRegex(ValueError, 'unexpected runtime changes'):
                        build.build(Path(tmp), 'candidate', target)
                self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
