"""Focused safeguards for the selective cache-breakdown release."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


# Re-run the unchanged transaction's integrity and recovery checks.
ReleaseTests = module('prior_release_checks', HERE.parent / 'jar1-codex-usage/test_release.py').ReleaseTests


class CacheReleaseTests(unittest.TestCase):
    def test_builder_and_both_transaction_wrappers_select_the_same_files(self):
        builder = module('cache_builder_check', HERE / 'build.py')
        bot = module('cache_bot_deploy_check', HERE / 'deploy.py')
        pult = module('cache_pult_deploy_check', HERE / 'pult-deploy.py')
        self.assertEqual(builder.BOT, bot.BOT)
        self.assertEqual(builder.PULT, pult.FILES)
        self.assertEqual(len(builder.BOT), 6)
        self.assertEqual(len(builder.PULT), 5)

    def test_overlay_payload_must_match_the_tested_composite(self):
        verify = module('cache_verify_check', HERE / 'verify.py')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'source'; composite = root / 'composite'
            file = composite / 'overlay/bot/ext/adapters/saved-codex.mjs'
            file.parent.mkdir(parents=True)
            file.write_text('tested')
            manifest = {'files': [{'source': 'overlay/bot/ext/adapters/saved-codex.mjs',
                                   'after_sha256': hashlib.sha256(b'different').hexdigest()}], 'pult_files': []}
            with self.assertRaisesRegex(RuntimeError, 'Composite bot source differs'):
                verify.verify_payload_source(root, source, composite, manifest)


if __name__ == '__main__': unittest.main()
