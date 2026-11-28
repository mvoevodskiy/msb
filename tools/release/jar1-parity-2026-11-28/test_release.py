import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import build
import verify


class ParityReleaseTests(unittest.TestCase):
    def test_accepted_delta_becomes_the_before_inventory(self):
        rows = [{'root': 'bot', 'relative': f'src/{index}.mjs', 'sha256': '1' * 64}
                for index in range(342)]
        rows.extend({'root': root, 'relative': str(index), 'sha256': '1' * 64}
                    for root, size in (('bin', 1), ('engine', 11)) for index in range(size))
        existing = rows[0]
        new = {'root': 'bot', 'relative': 'src/addition.mjs'}
        prior = {'source_commit': build.BASE_COMMIT, 'scope': 'jar1-parity-2026-11-28-v1',
                 'baseline_inventory': rows, 'support_files': list(range(6)),
                 'files': [{**new, 'before_sha256': None, 'after_sha256': '2' * 64},
                           {**existing, 'before_sha256': '1' * 64, 'after_sha256': '3' * 64}]}
        raw = json.dumps(prior).encode()
        with patch.object(build, 'BASE_MANIFEST', build.sha(raw)):
            result, support = build.installed_inventory(raw)
            self.assertEqual(result, [{**existing, 'sha256': '3' * 64}, *rows[1:],
                                      {**new, 'sha256': '2' * 64}])
            self.assertEqual(support, prior['support_files'])
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                build.installed_inventory(raw + b'\n')

    def test_proof_is_pinned_to_the_accepted_snapshot(self):
        prior = {'source_commit': build.BASE_COMMIT, 'scope': 'jar1-parity-2026-11-28-v1',
                 'source_archive_sha256': 'a' * 64}
        raw = json.dumps(prior).encode()
        proof = json.dumps({**prior, 'passed': True, 'manifest_sha256': build.sha(raw)}).encode()
        with patch.object(build, 'BASE_MANIFEST', build.sha(raw)), patch.object(build, 'BASE_PROOF', build.sha(proof)):
            build.check_prior_proof(raw, proof)
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                build.check_prior_proof(raw, proof + b'\n')

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
