import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import build
import verify


class ParityReleaseTests(unittest.TestCase):
    def test_accepted_delta_and_footer_become_the_before_inventory(self):
        old = {'root': 'bot', 'relative': build.FOOTER, 'sha256': build.FOOTER_BEFORE}
        new = {'root': 'bot', 'relative': 'src/addition.mjs'}
        prior = {'source_commit': build.UX_COMMIT, 'scope': 'jar1-ux-v1',
                 'baseline_inventory': [old], 'support_files': [],
                 'files': [{**new, 'before_sha256': None, 'after_sha256': '2' * 64}]}
        raw = json.dumps(prior).encode()
        with patch.object(build, 'BASE_MANIFEST', build.sha(raw)):
            rows, support = build.installed_inventory(raw)
            self.assertEqual(rows, [{**old, 'sha256': build.FOOTER_INSTALLED},
                                    {**new, 'sha256': '2' * 64}])
            self.assertEqual(support, [])
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                build.installed_inventory(raw + b'\n')

    def test_payload_and_archived_operator_bytes_are_bound(self):
        name = 'src/fixture.mjs'
        source = build.source_path('bot', name)
        tool = 'tools/release/fixture.py'
        data = b'fixture\n'
        digest = build.sha(data)
        selected = {'root': 'bot', 'relative': name, 'source': source,
                    'before_sha256': None, 'after_sha256': digest}
        manifest = {'schema': 1, 'scope': build.SCOPE, 'base_commit': build.BASE_COMMIT,
                    'prior_sha256': build.BASE_MANIFEST, 'baseline_inventory': [],
                    'support_files': [], 'files': [selected], 'fixture_sha256': digest}
        with TemporaryDirectory() as directory, patch.object(build, 'FILES', (name,)), \
             patch.object(build, 'TOOLS', {'fixture.py': tool}), \
             patch.object(build, 'installed_inventory', return_value=([], [])):
            stage = Path(directory)
            payload = stage / 'payload/bot' / name
            archived_tool = stage / 'source' / tool
            for path in (payload, archived_tool, stage / 'prior.json', stage / 'fixture.py'):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            verify.verify_artifact(stage, manifest, build)
            archived_tool.write_bytes(b'wrong')
            with self.assertRaisesRegex(ValueError, 'archived source'):
                verify.verify_artifact(stage, manifest, build)
            payload.write_bytes(b'wrong')
            with self.assertRaisesRegex(ValueError, 'selected payload'):
                verify.verify_artifact(stage, manifest, build)

    def test_notification_regression_is_required(self):
        self.assertIn('.msb/bot/tests/notification-settings.test.mjs', verify.REQUIRED_CORE)


if __name__ == '__main__':
    unittest.main()
