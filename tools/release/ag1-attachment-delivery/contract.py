"""Fixed AG1 code-only attachment-delivery release contract.

The host evidence is limited to code hashes and service metadata; no token,
conversation, or user data is included in this file.
"""

import hashlib
import re
from pathlib import Path

HOST = 'VM-753921'
UNIT = 'msb-bot@default.service'
BOT = Path('/home/client/.msb/bot')
OWNER = 'client'
MODE = 0o664
DEPENDENCIES = BOT / 'node_modules'
ISOLATED_DEPENDENCIES = Path('/tmp/ag1-runtime/node_modules')
BACKUPS = Path('/var/lib/msb-ops/ag1-attachment-delivery')
TOOLS = 'tools/release/ag1-attachment-delivery'
OLD_PRIMITIVES = 'tools/release/jar1-audit-2026-11-20/deploy.py'
OLD_RUNTIME = 'tools/release/jar1-audit-2026-11-20/runtime.py'
BASELINE_FILES = ('ag1-code-inventory.json', 'ag1-entry-inventory.json')
OPERATOR_TESTS = ('test_transaction.py', 'test_deploy.py', 'test_checks.py')
OPERATOR_TEST_COUNT = 9

# runtime path -> (candidate Git path, live-before SHA-256, candidate SHA-256)
FILES = {
    'src/telegram/bot.mjs': (
        '.msb/bot/src/telegram/bot.mjs',
        '2472f27d4d7cc50e05995643be4c8fee78deaeccc1b1ab8aeaa64f5442147442',
        'b0fe59f8720844caec2902782c40f865ba32137a3dfedacbb56f0bb63e3046db'),
    'src/telegram/send-media.mjs': (
        '.msb/bot/src/telegram/send-media.mjs',
        'e4c4664c75f53d63b2382756dc7d1aec49dc30e3ef81a7ebb5b83082d46526ca',
        '25254a86c8c36652df7b1db091670fa6eefb9e69605f4666eaa96d1c9cc53282'),
    'src/telegram/media-markers.mjs': (
        '.msb/bot/src/telegram/media-markers.mjs',
        'ca89d3760aa868b0ba5bc9399b04a2805262a3e802274b01f4a634d9304b0c27',
        '522f6b8ebb418f48dbcba6ac8934e28a45fe97a1743ca16581a0d16490eccfee'),
}

UNCHANGED = {
    'src/telegram/response.mjs': 'dd85ce05166196d85946d1603ddf53d0c40d8e9a947efeb36c258b8839fa9ef3',
    'src/agent/turn.mjs': '39aae1665645bc9f5e27b7081bc206d414567aeade1dfc53473a87c1a62338fd',
    'ext/shim/run-turn.mjs': 'f14d8801469b4434d10251f25a2eb0dc3cb9d51938d3be7523a01fe3d880265d',
}

TESTS = (
    '.msb/bot/tests/outbound-media-response.test.mjs',
    '.msb/bot/tests/media-markers.test.mjs',
    '.msb/bot/tests/send-media.test.mjs',
    '.msb/bot/tests/response-delivery.test.mjs',
)
REQUIRED_CASES = (
    'codex attachment-only response delivers sendDocument',
    'claude attachment-only response delivers sendPhoto',
    'failed attachment-only delivery keeps the missing-answer fallback',
    'a partially delivered media queue retains the existing visible failure notice',
)

# Never include excluded provider scenarios in this audit or inventory.
EXCLUDED = re.compile(r'openclaw|native.?oc|(?:^|[/_-])oc(?:[/_.-]|$)', re.I)
CODE_EXTENSIONS = frozenset(('.mjs', '.cjs', '.js', '.py', '.json', '.md'))


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def code_path(relative):
    """Whether a runtime-relative path belongs to the scoped code inventory."""
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or EXCLUDED.search(path.as_posix()):
        return False
    if not path.parts or path.parts[0] not in ('src', 'shared', 'ext'):
        return False
    if any(part in ('node_modules', 'tests', '__pycache__') for part in path.parts):
        return False
    return path.suffix in CODE_EXTENSIONS or path.as_posix() == 'ext/shim/bin/claude'
