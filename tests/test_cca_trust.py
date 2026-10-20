"""Tests for libexec/cca-trust. Run: python3 -m unittest discover -s tests"""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader('cca_trust', str(HERE.parent / 'libexec' / 'cca-trust'))
spec = importlib.util.spec_from_loader('cca_trust', loader)
trust = importlib.util.module_from_spec(spec)
loader.exec_module(trust)

LITERAL = (b'x}var uhe={allowedTools:[],mcpContextUris:[],mcpServers:{},enabledMcpjsonServers:[],'
           b'disabledMcpjsonServers:[],hasTrustDialogAccepted:!1,hasClaudeMdExternalIncludesApproved:!1,'
           b'hasClaudeMdExternalIncludesWarningShown:!1};function Ke(){')
DEFAULTS = {
    'allowedTools': [], 'mcpContextUris': [], 'mcpServers': {}, 'enabledMcpjsonServers': [],
    'disabledMcpjsonServers': [], 'hasTrustDialogAccepted': False,
    'hasClaudeMdExternalIncludesApproved': False, 'hasClaudeMdExternalIncludesWarningShown': False,
}


class Defaults(unittest.TestCase):
    def test_reads_the_default_project_entry(self):
        self.assertEqual(trust.parse_defaults(b'junk' + LITERAL + b'junk'), DEFAULTS)

    def test_refuses_a_shape_it_does_not_know(self):
        self.assertIsNone(trust.parse_defaults(b'{allowedTools:[],mcpServers:foo(),hasTrustDialogAccepted:!1}'))
        self.assertIsNone(trust.parse_defaults(b'{allowedTools:[],mcpServers:{},other:!1}'))
        self.assertIsNone(trust.parse_defaults(b'no entry here'))
        self.assertIsNone(trust.parse_defaults(b'{allowedTools:[],mcpServers:{' + b' ' * 3000))

    def test_the_installed_claude_still_has_the_shape(self):
        binary = os.path.expanduser('~/.local/bin/claude')
        if not os.path.exists(binary):
            self.skipTest('no installed claude')
        with tempfile.TemporaryDirectory() as cache, mock.patch.object(trust, 'CACHE', cache):
            entry = trust.project_defaults(binary)
            self.assertIsNotNone(entry, 'Claude Code changed its default project entry; cca-trust needs a look')
            self.assertIs(entry['hasTrustDialogAccepted'], False)
            self.assertEqual(entry['allowedTools'], [])
            self.assertEqual(len(os.listdir(cache)), 1, 'cached per binary')

    def test_each_new_entry_gets_its_own_lists(self):
        config = {'projects': {}}
        trust.add_trust(config, {'/a', '/b'}, DEFAULTS)
        config['projects']['/a']['allowedTools'].append('Bash')
        self.assertEqual(config['projects']['/b']['allowedTools'], [])


class Sync(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.dir.name)
        self.target = self.root / 'target.json'
        self.source = self.root / 'source.json'

    def tearDown(self):
        self.dir.cleanup()

    def write(self, path, projects, mode=0o600, **rest):
        path.write_text(json.dumps({'oauthAccount': {'emailAddress': 'a@b'}, **rest, 'projects': projects}, indent=2))
        os.chmod(path, mode)

    def read(self, path):
        return json.loads(path.read_text())

    def sync(self, defaults=DEFAULTS):
        err = StringIO()
        with redirect_stderr(err):
            added = trust.sync(str(self.target), [str(self.source)], defaults)
        return added, err.getvalue()

    def test_trusts_on_the_target_what_a_source_trusts(self):
        self.write(self.source, {'/a': {'hasTrustDialogAccepted': True}, '/b': {'hasTrustDialogAccepted': False}})
        self.write(self.target, {'/a': {'hasTrustDialogAccepted': False, 'allowedTools': ['Bash'], 'lastCost': 3}},
                   numStartups=7)
        added, _ = self.sync()
        self.assertEqual(added, ['/a'])
        config = self.read(self.target)
        self.assertEqual(config['projects']['/a'], {'hasTrustDialogAccepted': True, 'allowedTools': ['Bash'], 'lastCost': 3})
        self.assertNotIn('/b', config['projects'])
        self.assertEqual(config['numStartups'], 7)
        self.assertEqual(config['oauthAccount'], {'emailAddress': 'a@b'})

    def test_a_folder_the_target_never_opened_gets_the_default_entry(self):
        self.write(self.source, {'/new': {'hasTrustDialogAccepted': True, 'allowedTools': ['Bash']}})
        self.write(self.target, {})
        self.sync()
        self.assertEqual(self.read(self.target)['projects']['/new'], {**DEFAULTS, 'hasTrustDialogAccepted': True})

    def test_without_the_default_entry_only_existing_folders_are_trusted(self):
        self.write(self.source, {'/new': {'hasTrustDialogAccepted': True}, '/old': {'hasTrustDialogAccepted': True}})
        self.write(self.target, {'/old': {'hasTrustDialogAccepted': False}})
        added, _ = self.sync(defaults=None)
        self.assertEqual(added, ['/old'])
        self.assertNotIn('/new', self.read(self.target)['projects'])

    def test_keeps_the_config_permissions_and_leaves_no_lock_or_temp(self):
        self.write(self.source, {'/a': {'hasTrustDialogAccepted': True}})
        self.write(self.target, {}, mode=0o644)
        self.sync()
        self.assertEqual(stat.S_IMODE(os.stat(self.target).st_mode), 0o644)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['source.json', 'target.json'])

    def test_writes_nothing_when_the_target_already_trusts_everything(self):
        self.write(self.source, {'/a': {'hasTrustDialogAccepted': True}})
        self.write(self.target, {'/a': {'hasTrustDialogAccepted': True}})
        before = self.target.read_bytes(), os.stat(self.target).st_ino
        self.assertEqual(self.sync(), ([], ''))
        self.assertEqual((self.target.read_bytes(), os.stat(self.target).st_ino), before)

    def test_never_breaks_a_running_session_lock(self):
        self.write(self.source, {'/a': {'hasTrustDialogAccepted': True}})
        self.write(self.target, {})
        os.mkdir(f'{self.target}.lock')
        with mock.patch.object(trust, 'LOCK_WAIT_S', 0.1):
            added, err = self.sync()
        self.assertIsNone(added)
        self.assertIn('stayed locked', err)
        self.assertEqual(self.read(self.target)['projects'], {})
        self.assertTrue(os.path.isdir(f'{self.target}.lock'), 'the other process still owns its lock')

    def test_a_corrupt_source_is_skipped_and_a_corrupt_target_left_alone(self):
        self.source.write_text('{broken')
        self.write(self.target, {})
        added, err = self.sync()
        self.assertEqual(added, [])
        self.assertIn('skipped', err)
        self.write(self.source, {'/a': {'hasTrustDialogAccepted': True}})
        self.target.write_text('{broken')
        added, err = self.sync()
        self.assertIsNone(added)
        self.assertEqual(self.target.read_text(), '{broken')
        self.assertFalse(os.path.exists(f'{self.target}.lock'))

    def test_a_missing_target_is_left_for_claude_to_create(self):
        self.write(self.source, {'/a': {'hasTrustDialogAccepted': True}})
        self.assertEqual(self.sync(), ([], ''))
        self.assertFalse(self.target.exists())


if __name__ == '__main__':
    unittest.main()
