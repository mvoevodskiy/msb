"""Dependency fingerprint catches code changes even when versions do not change."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release_runtime', Path(__file__).with_name('runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTest(unittest.TestCase):
    def test_changed_package_bytes_change_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = root / 'node_modules'
            package = deps / 'example'
            package.mkdir(parents=True)
            (package / 'package.json').write_text('{"name":"example","version":"1.0.0"}')
            code = package / 'index.js'
            code.write_text('one')
            lock = root / 'lock.json'
            lock.write_text(json.dumps({'packages': {'': {}, 'node_modules/example': {'version': '1.0.0'}}}))
            before = runtime.runtime_info(lock, deps)
            code.write_text('two')
            after = runtime.runtime_info(lock, deps)
            self.assertEqual(before['dependency_versions_sha256'], after['dependency_versions_sha256'])
            self.assertNotEqual(before['dependency_tree_sha256'], after['dependency_tree_sha256'])
            self.assertEqual(before['node_sha256'], after['node_sha256'])

    def test_dependency_symlink_cannot_escape_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = root / 'node_modules'
            deps.mkdir()
            (root / 'outside').write_text('fixture')
            (deps / 'link').symlink_to(root / 'outside')
            lock = root / 'lock.json'
            lock.write_text('{"packages":{"":{}}}')
            with self.assertRaisesRegex(ValueError, 'escapes'):
                runtime.runtime_info(lock, deps)


if __name__ == '__main__':
    unittest.main()
