"""Launcher checks only synthetic service and namespace metadata."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('steer_launcher', Path(__file__).with_name('launcher.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class LauncherTest(unittest.TestCase):
    def test_captures_service_host_namespace(self):
        result = SimpleNamespace(stdout='MainPID=123\nActiveState=active\n')
        with patch.object(launcher.subprocess, 'run', return_value=result), \
             patch.object(launcher.os, 'stat', return_value=SimpleNamespace(st_ino=42)):
            self.assertEqual(launcher.bot_netns(), 42)

    def test_rejects_bot_on_different_network_namespace(self):
        result = SimpleNamespace(stdout='MainPID=123\nActiveState=active\n')
        with patch.object(launcher.subprocess, 'run', return_value=result), \
             patch.object(launcher.os, 'stat', side_effect=[SimpleNamespace(st_ino=42), SimpleNamespace(st_ino=43)]):
            with self.assertRaisesRegex(RuntimeError, 'netns differs'):
                launcher.bot_netns()

    def test_inactive_bot_rejected(self):
        with patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(stdout='MainPID=0\nActiveState=inactive\n')):
            with self.assertRaisesRegex(RuntimeError, 'not active'):
                launcher.bot_netns()

if __name__ == '__main__': unittest.main()
