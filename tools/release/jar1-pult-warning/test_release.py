import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('pult_warning_deploy', Path(__file__).with_name('pult-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def manifest():
    files = [{'root': 'pult', 'relative': name, 'source': '.msb/pult/' + name,
              'before_sha256': 'a' * 64, 'after_sha256': 'b' * 64} for name in deploy.FILES]
    return {'schema': 1, 'scope': deploy.SCOPE, 'base_commit': deploy.BASE, 'source_commit': 'c' * 40,
            'ccusage_binary_sha256': deploy.CCUSAGE_SHA256, 'source_archive_sha256': 'd' * 64,
            'pult_files': files, 'pult_baseline_inventory': [
                *[{'relative': item['relative'], 'sha256': item['before_sha256']} for item in files],
                {'relative': 'config/ccusage-report.json', 'sha256': 'e' * 64}]}


def report(m):
    return {'scope': m['scope'], 'source_commit': m['source_commit'], 'manifest_sha256': 'f' * 64,
            'source_archive_sha256': m['source_archive_sha256'], 'environment': {'node_sha256': 'a' * 64},
            'excluded_tests': deploy.EXCLUDED_TESTS,
            'checks': [{'suite': 'typecheck', 'passed': 1, 'exit_code': 0},
                       {'suite': 'pult-tests', 'passed': 20, 'exit_code': 0, 'skipped': 0},
                       {'suite': 'release-tests', 'passed': 3, 'exit_code': 0}], 'passed': True}


class ReleaseContract(unittest.TestCase):
    def test_expected_payload_and_proof_are_accepted(self):
        m = manifest()
        deploy.validate_manifest(m)
        deploy.validate_report(report(m), m, 'f' * 64)

    def test_patch_allows_collector_config_and_ui_targets_with_matching_proof(self):
        m = manifest()
        m.update(scope=deploy.PATCH_SCOPE, base_commit='d' * 40)
        for name in ('src/shared/config.ts', 'src/ui/view-overview.js'):
            m['pult_files'].append({'root': 'pult', 'relative': name, 'source': '.msb/pult/' + name,
                                    'before_sha256': 'a' * 64, 'after_sha256': 'b' * 64})
            m['pult_baseline_inventory'].append({'relative': name, 'sha256': 'a' * 64})
        deploy.validate_manifest(m)
        deploy.validate_report(report(m), m, 'f' * 64)
        stale_proof = {**report(m), 'scope': deploy.SCOPE}
        with self.assertRaises(RuntimeError): deploy.validate_report(stale_proof, m, 'f' * 64)
        for target in ('src/collector/../server/app.ts', 'src/server/app.ts', 'src/shared/registry.ts', 'config/pult.config.json'):
            invalid = copy.deepcopy(m)
            invalid['pult_files'][-1].update(relative=target, source='.msb/pult/' + target)
            invalid['pult_files'].sort(key=lambda row: row['relative'])
            invalid['pult_baseline_inventory'][-1]['relative'] = target
            with self.assertRaises(RuntimeError): deploy.validate_manifest(invalid)

    def test_unexpected_file_and_baseline_drift_are_rejected(self):
        for mutate in (lambda m: m['pult_files'].append(m['pult_files'][0]),
                       lambda m: m['pult_baseline_inventory'][0].update(sha256='0' * 64),
                       lambda m: m.update(base_commit='0' * 40)):
            m = manifest()
            mutate(m)
            with self.assertRaises(RuntimeError): deploy.validate_manifest(m)

    def test_old_or_incomplete_test_proof_is_rejected(self):
        m = manifest()
        for mutate in (lambda r: r.update(source_commit='0' * 40),
                       lambda r: r['checks'].pop(),
                       lambda r: r['checks'][1].update(skipped=2),
                       lambda r: r['checks'][1].update(exit_code=1)):
            r = copy.deepcopy(report(m))
            mutate(r)
            with self.assertRaises(RuntimeError): deploy.validate_report(r, m, 'f' * 64)


if __name__ == '__main__':
    unittest.main()
