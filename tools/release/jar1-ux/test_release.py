import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build
import deploy


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {
            'scope': build.SCOPE,
            'source_commit': '1' * 40,
            'source_archive_sha256': '2' * 64,
        }
        self.manifest_sha = '3' * 64
        self.proof = {
            **self.manifest,
            'manifest_sha256': self.manifest_sha,
            'passed': True,
            'checks': [{'suite': name, 'exit_code': 0, 'passed': 1, 'skipped': 0, 'cancelled': 0}
                       for name in sorted(deploy.SUITES)],
            'environment': {'platform': 'linux', 'node': 'v22.23.5', 'node_sha256': '4' * 64},
            'native_identity': {'host_netns_inode': 100, 'test_netns_inode': 101,
                                'wrapper_sha256': '5' * 64, 'binary_sha256': '6' * 64},
        }

    def test_only_this_candidate_with_all_suites_can_pass(self):
        env, native = deploy.verify_proof(self.proof, self.manifest, self.manifest_sha)
        self.assertEqual(env['node'], 'v22.23.5')
        self.assertNotEqual(native['host_netns_inode'], native['test_netns_inode'])
        with self.assertRaisesRegex(RuntimeError, 'candidate'):
            deploy.verify_proof(self.proof, self.manifest, '0' * 64)
        self.proof['checks'].pop()
        with self.assertRaisesRegex(RuntimeError, 'suites'):
            deploy.verify_proof(self.proof, self.manifest, self.manifest_sha)

    def test_skipped_or_unisolated_native_cannot_pass(self):
        partial = copy.deepcopy(self.proof)
        next(row for row in partial['checks'] if row['suite'] == 'native-steer')['skipped'] = 1
        with self.assertRaisesRegex(RuntimeError, 'Incomplete test suite'):
            deploy.verify_proof(partial, self.manifest, self.manifest_sha)
        self.proof['native_identity']['test_netns_inode'] = 100
        with self.assertRaisesRegex(RuntimeError, 'Isolated Codex identity'):
            deploy.verify_proof(self.proof, self.manifest, self.manifest_sha)

    def test_previous_manifest_delta_becomes_the_installed_baseline(self):
        existing = {'root': 'bot', 'relative': 'src/example.mjs', 'sha256': '1' * 64}
        prior = {'source_commit': build.BASE_COMMIT, 'scope': 'jar1-attachment-delivery-v1',
                 'baseline_inventory': [existing], 'support_files': [],
                 'files': [{**existing, 'before_sha256': existing['sha256'], 'after_sha256': '2' * 64}]}
        raw = json.dumps(prior).encode()
        with patch.object(build, 'BASE_MANIFEST', build.sha(raw)):
            rows, support = build.installed_inventory(raw)
            self.assertEqual(rows, [{**existing, 'sha256': '2' * 64}])
            self.assertEqual(support, [])
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                build.installed_inventory(raw + b'\n')

    def test_delta_hash_and_order_are_checked_before_apply(self):
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            name = 'src/existing.mjs'
            data = b'fixed\n'
            before = {'root': 'bot', 'relative': name, 'sha256': '7' * 64}
            item = {'root': 'bot', 'relative': name, 'source': '.msb/bot/' + name,
                    'before_sha256': before['sha256'], 'after_sha256': build.sha(data)}
            (stage / 'payload/bot/src').mkdir(parents=True)
            payload = stage / 'payload/bot' / name
            payload.write_bytes(data)
            (stage / 'source.tar.gz').write_bytes(b'source')
            (stage / 'prior.json').write_bytes(b'prior')
            manifest = {**self.manifest, 'schema': 1, 'base_commit': build.BASE_COMMIT,
                        'prior_sha256': build.BASE_MANIFEST, 'baseline_inventory': [before],
                        'support_files': [], 'files': [item], 'source_archive_sha256': build.sha(b'source')}
            with patch.object(build, 'FILES', (name,)), \
                 patch.object(build, 'installed_inventory', return_value=([before], [])), \
                 patch.object(deploy, 'trusted', side_effect=lambda root, rel: (root / rel).read_bytes()):
                self.assertEqual(deploy.verify_payload(stage, manifest, build), [item])
                payload.write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, 'payload changed'):
                    deploy.verify_payload(stage, manifest, build)


if __name__ == '__main__':
    unittest.main()
