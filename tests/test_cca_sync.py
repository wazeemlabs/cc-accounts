"""Tests for libexec/cca-sync. Run: python3 -m unittest discover -s tests"""
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
loader = importlib.machinery.SourceFileLoader('cca_sync', str(HERE.parent / 'libexec' / 'cca-sync'))
spec = importlib.util.spec_from_loader('cca_sync', loader)
cca_sync = importlib.util.module_from_spec(spec)
loader.exec_module(cca_sync)

LITERAL = (b'x}var uhe={allowedTools:[],mcpContextUris:[],mcpServers:{},enabledMcpjsonServers:[],'
           b'disabledMcpjsonServers:[],hasTrustDialogAccepted:!1,hasClaudeMdExternalIncludesApproved:!1,'
           b'hasClaudeMdExternalIncludesWarningShown:!1};function Ke(){')
DEFAULTS = {
    'allowedTools': [], 'mcpContextUris': [], 'mcpServers': {}, 'enabledMcpjsonServers': [],
    'disabledMcpjsonServers': [], 'hasTrustDialogAccepted': False,
    'hasClaudeMdExternalIncludesApproved': False, 'hasClaudeMdExternalIncludesWarningShown': False,
}
FETCH = {'command': 'npx', 'args': ['fetcher'], 'env': {'API_KEY': 'secret-123'}}
SEARCH = {'type': 'http', 'url': 'https://search.example/mcp'}


class Defaults(unittest.TestCase):
    def test_reads_the_default_project_entry(self):
        self.assertEqual(cca_sync.parse_defaults(b'junk' + LITERAL + b'junk'), DEFAULTS)

    def test_refuses_a_shape_it_does_not_know(self):
        self.assertIsNone(cca_sync.parse_defaults(b'{allowedTools:[],mcpServers:foo(),hasTrustDialogAccepted:!1}'))
        self.assertIsNone(cca_sync.parse_defaults(b'{allowedTools:[],mcpServers:{},other:!1}'))
        self.assertIsNone(cca_sync.parse_defaults(b'no entry here'))
        self.assertIsNone(cca_sync.parse_defaults(b'{allowedTools:[],mcpServers:{' + b' ' * 3000))

    def test_the_installed_claude_still_has_the_shape(self):
        binary = os.path.expanduser('~/.local/bin/claude')
        if not os.path.exists(binary):
            self.skipTest('no installed claude')
        with tempfile.TemporaryDirectory() as cache, mock.patch.object(cca_sync, 'CACHE', cache):
            entry = cca_sync.project_defaults(binary)
            self.assertIsNotNone(entry, 'Claude Code changed its default project entry; cca-sync needs a look')
            self.assertIs(entry['hasTrustDialogAccepted'], False)
            self.assertEqual(entry['allowedTools'], [])
            self.assertEqual(len(os.listdir(cache)), 1, 'cached per binary')


class Accounts(unittest.TestCase):
    """Three accounts: home (~/.claude.json, which holds the shared copy), a and b."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.dir.name)
        self.home, self.a, self.b = (self.root / name for name in ('home.json', 'a.json', 'b.json'))
        self.state = self.root / 'state' / 'sync-state.json'

    def tearDown(self):
        self.dir.cleanup()

    def write(self, path, projects=None, mode=0o600, **rest):
        config = {'oauthAccount': {'emailAddress': f'{path.stem}@example.com'}, **rest, 'projects': projects or {}}
        path.write_text(json.dumps(config, indent=2))
        os.chmod(path, mode)

    def read(self, path):
        return json.loads(path.read_text())

    def servers(self, path):
        return self.read(path).get('mcpServers', {})

    def sync(self, target, defaults=DEFAULTS, **kinds):
        err = StringIO()
        with redirect_stderr(err):
            report = cca_sync.sync(str(self.home), str(target), [str(p) for p in (self.home, self.a, self.b)],
                                   defaults, str(self.state), **kinds)
        return report, err.getvalue()


class Trust(Accounts):
    def test_trusts_on_the_target_what_another_account_trusts(self):
        self.write(self.home)
        self.write(self.a, {'/a': {'hasTrustDialogAccepted': True}, '/b': {'hasTrustDialogAccepted': False}})
        self.write(self.b, {'/a': {'hasTrustDialogAccepted': False, 'allowedTools': ['Bash'], 'lastCost': 3}},
                   numStartups=7)
        report, err = self.sync(self.b)
        self.assertEqual(report['trusted'], ['/a'])
        self.assertEqual(err, 'cca: trusted 1 folder(s) another account trusts: /a\n')
        config = self.read(self.b)
        self.assertEqual(config['projects']['/a'], {'hasTrustDialogAccepted': True, 'allowedTools': ['Bash'], 'lastCost': 3})
        self.assertNotIn('/b', config['projects'])
        self.assertEqual((config['numStartups'], config['oauthAccount']), (7, {'emailAddress': 'b@example.com'}))

    def test_the_home_config_keeps_the_union_too(self):
        self.write(self.home)
        self.write(self.a, {'/a': {'hasTrustDialogAccepted': True}})
        self.write(self.b)
        self.sync(self.b)
        self.assertIs(self.read(self.home)['projects']['/a']['hasTrustDialogAccepted'], True)

    def test_a_folder_the_target_never_opened_gets_the_default_entry(self):
        self.write(self.home, {'/new': {'hasTrustDialogAccepted': True, 'allowedTools': ['Bash']}})
        self.write(self.a)
        self.write(self.b)
        self.sync(self.b)
        self.assertEqual(self.read(self.b)['projects']['/new'], {**DEFAULTS, 'hasTrustDialogAccepted': True})

    def test_each_new_entry_gets_its_own_lists(self):
        self.write(self.home, {'/x': {'hasTrustDialogAccepted': True}, '/y': {'hasTrustDialogAccepted': True}})
        self.write(self.a)
        self.write(self.b)
        self.sync(self.b)
        projects = self.read(self.b)['projects']
        projects['/x']['allowedTools'].append('Bash')
        self.assertEqual(projects['/y']['allowedTools'], [])

    def test_without_the_default_entry_only_existing_folders_are_trusted(self):
        self.write(self.home, {'/new': {'hasTrustDialogAccepted': True}, '/old': {'hasTrustDialogAccepted': True}})
        self.write(self.a)
        self.write(self.b, {'/old': {'hasTrustDialogAccepted': False}})
        report, _ = self.sync(self.b, defaults=None)
        self.assertEqual(report['trusted'], ['/old'])
        self.assertNotIn('/new', self.read(self.b)['projects'])

    def test_trust_removed_on_one_account_stays_on_the_others(self):
        self.write(self.home, {'/a': {'hasTrustDialogAccepted': True}})
        self.write(self.a, {'/a': {'hasTrustDialogAccepted': True}})
        self.write(self.b, {'/a': {'hasTrustDialogAccepted': True}})
        self.sync(self.b)
        self.write(self.a)
        self.sync(self.b)
        self.assertIs(self.read(self.b)['projects']['/a']['hasTrustDialogAccepted'], True)
        self.assertIs(self.read(self.home)['projects']['/a']['hasTrustDialogAccepted'], True)

    def test_trust_off_leaves_trust_alone(self):
        self.write(self.home, {'/a': {'hasTrustDialogAccepted': True}}, mcpServers={'fetch': FETCH})
        self.write(self.a)
        self.write(self.b)
        self.sync(self.b, trust=False)
        self.assertEqual((self.read(self.b)['projects'], self.servers(self.b)), ({}, {'fetch': FETCH}))


class McpServers(Accounts):
    def test_gives_the_target_the_servers_another_account_has(self):
        self.write(self.home, mcpServers={'fetch': FETCH, 'search': SEARCH})
        self.write(self.a, mcpServers={'fetch': FETCH})
        self.write(self.b)
        report, err = self.sync(self.b)
        self.assertEqual(self.servers(self.b), {'fetch': FETCH, 'search': SEARCH})
        self.assertEqual(report['added'], ['fetch', 'search'])
        self.assertEqual(err, 'cca: MCP servers from the other accounts: added fetch, search\n')

    def test_a_server_added_on_any_account_reaches_the_others(self):
        self.write(self.home)
        self.write(self.a)
        self.write(self.b)
        self.sync(self.a)
        self.sync(self.b)
        self.write(self.a, mcpServers={'search': SEARCH})
        self.sync(self.b)
        self.assertEqual((self.servers(self.home), self.servers(self.b)), ({'search': SEARCH}, {'search': SEARCH}))

    def test_a_server_removed_on_any_account_is_removed_from_the_others(self):
        for path in (self.home, self.a, self.b):
            self.write(path, mcpServers={'fetch': FETCH, 'search': SEARCH})
        self.sync(self.a)
        self.sync(self.b)
        self.write(self.a, mcpServers={'fetch': FETCH})
        report, err = self.sync(self.b)
        self.assertEqual((self.servers(self.home), self.servers(self.b)), ({'fetch': FETCH}, {'fetch': FETCH}))
        self.assertEqual(report['removed'], ['search'])
        self.assertIn('removed search', err)

    def test_a_server_changed_on_one_account_changes_everywhere(self):
        for path in (self.home, self.a, self.b):
            self.write(path, mcpServers={'fetch': FETCH})
        self.sync(self.a)
        self.sync(self.b)
        moved = {**FETCH, 'args': ['fetcher', '--v2']}
        self.write(self.a, mcpServers={'fetch': moved})
        report, _ = self.sync(self.b)
        self.assertEqual((self.servers(self.home), self.servers(self.b)), ({'fetch': moved}, {'fetch': moved}))
        self.assertEqual(report['changed'], ['fetch'])

    def test_the_targets_own_change_is_kept(self):
        for path in (self.home, self.a, self.b):
            self.write(path, mcpServers={'fetch': FETCH})
        self.sync(self.b)
        mine = {**FETCH, 'command': 'uvx'}
        self.write(self.b, mcpServers={'fetch': mine})
        report, err = self.sync(self.b)
        self.assertEqual((self.servers(self.home), self.servers(self.b)), ({'fetch': mine}, {'fetch': mine}))
        self.assertEqual((report['changed'], err), ([], ''))

    def test_an_account_seen_for_the_first_time_adds_but_does_not_overwrite(self):
        self.write(self.home, mcpServers={'fetch': FETCH})
        self.write(self.a, mcpServers={'fetch': {'command': 'old'}, 'search': SEARCH})
        self.write(self.b)
        self.sync(self.b)
        self.assertEqual(self.servers(self.b), {'fetch': FETCH, 'search': SEARCH})

    def test_local_servers_and_mcp_json_approvals_follow_the_project(self):
        self.write(self.home)
        self.write(self.a, {'/p': {**DEFAULTS, 'hasTrustDialogAccepted': True, 'mcpServers': {'db': FETCH},
                                   'enabledMcpjsonServers': ['team'], 'disabledMcpjsonServers': ['noisy']}})
        self.write(self.b, {'/p': {'allowedTools': ['Bash']}})
        report, _ = self.sync(self.b)
        self.assertEqual(self.read(self.b)['projects']['/p'], {
            'allowedTools': ['Bash'], 'hasTrustDialogAccepted': True, 'mcpServers': {'db': FETCH},
            'enabledMcpjsonServers': ['team'], 'disabledMcpjsonServers': ['noisy']})
        self.assertEqual(report['added'], ['.mcp.json approvals in /p', 'db in /p'])
        self.sync(self.a)
        self.write(self.a, {'/p': {**DEFAULTS, 'hasTrustDialogAccepted': True}})
        self.sync(self.b)
        entry = self.read(self.b)['projects']['/p']
        self.assertEqual((entry['mcpServers'], entry['enabledMcpjsonServers'], entry['disabledMcpjsonServers']),
                         ({}, [], []))

    def test_a_local_server_for_a_folder_the_target_never_opened_needs_the_default_entry(self):
        self.write(self.home, {'/p': {'mcpServers': {'db': FETCH}}})
        self.write(self.a)
        self.write(self.b)
        self.sync(self.b, defaults=None)
        self.assertNotIn('/p', self.read(self.b)['projects'])
        self.sync(self.b)
        self.assertEqual(self.read(self.b)['projects']['/p'], {**DEFAULTS, 'mcpServers': {'db': FETCH}})

    def test_the_state_file_holds_digests_never_a_servers_settings(self):
        self.write(self.home, mcpServers={'fetch': FETCH})
        self.write(self.a)
        self.write(self.b)
        self.sync(self.b)
        self.assertNotIn('secret-123', self.state.read_text())
        self.assertNotIn('npx', self.state.read_text())
        self.assertEqual(stat.S_IMODE(os.stat(self.state).st_mode), 0o600)

    def test_mcp_off_leaves_servers_alone(self):
        self.write(self.home, {'/a': {'hasTrustDialogAccepted': True}}, mcpServers={'fetch': FETCH})
        self.write(self.a)
        self.write(self.b)
        self.sync(self.b, mcp=False)
        self.assertEqual(self.servers(self.b), {})
        self.assertIs(self.read(self.b)['projects']['/a']['hasTrustDialogAccepted'], True)


class Writing(Accounts):
    def test_keeps_each_configs_permissions_and_leaves_no_lock_or_temp(self):
        self.write(self.home, mode=0o644, mcpServers={'fetch': FETCH})
        self.write(self.a, {'/a': {'hasTrustDialogAccepted': True}})
        self.write(self.b, mode=0o640)
        self.sync(self.b)
        self.assertEqual((stat.S_IMODE(os.stat(self.home).st_mode), stat.S_IMODE(os.stat(self.b).st_mode)),
                         (0o644, 0o640))
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['a.json', 'b.json', 'home.json', 'state'])

    def test_writes_nothing_when_every_account_agrees(self):
        for path in (self.home, self.a, self.b):
            self.write(path, {'/a': {'hasTrustDialogAccepted': True}}, mcpServers={'fetch': FETCH})
        self.sync(self.b)
        before = [(p.read_bytes(), os.stat(p).st_ino) for p in (self.home, self.b)]
        self.assertEqual(self.sync(self.b)[1], '')
        self.assertEqual([(p.read_bytes(), os.stat(p).st_ino) for p in (self.home, self.b)], before)

    def test_never_breaks_a_running_sessions_lock(self):
        for locked in (self.home, self.b):
            self.write(self.home, mcpServers={'fetch': FETCH})
            self.write(self.a, {'/a': {'hasTrustDialogAccepted': True}})
            self.write(self.b)
            os.mkdir(f'{locked}.lock')
            with mock.patch.object(cca_sync, 'LOCK_WAIT_S', 0.1):
                report, err = self.sync(self.b)
            self.assertIsNone(report)
            self.assertIn('stayed locked', err)
            self.assertEqual((self.read(self.b)['projects'], self.servers(self.b)), ({}, {}))
            self.assertNotIn('/a', self.read(self.home)['projects'])
            self.assertTrue(os.path.isdir(f'{locked}.lock'), 'the other process still owns its lock')
            os.rmdir(f'{locked}.lock')

    def test_a_corrupt_source_is_skipped_and_a_corrupt_target_left_alone(self):
        self.write(self.home)
        self.a.write_text('{broken')
        self.write(self.b)
        report, err = self.sync(self.b)
        self.assertEqual(report['trusted'], [])
        self.assertIn('skipped', err)
        self.write(self.a, {'/a': {'hasTrustDialogAccepted': True}})
        self.b.write_text('{broken')
        report, _ = self.sync(self.b)
        self.assertIsNone(report)
        self.assertEqual(self.b.read_text(), '{broken')
        self.assertFalse(os.path.exists(f'{self.b}.lock'))

    def test_a_missing_target_is_left_for_claude_to_create(self):
        self.write(self.home)
        self.write(self.a, {'/a': {'hasTrustDialogAccepted': True}})
        self.assertEqual(self.sync(self.b), (None, ''))
        self.assertFalse(self.b.exists())

    def test_the_home_account_as_target_is_written_once(self):
        self.write(self.home)
        self.write(self.a, mcpServers={'fetch': FETCH})
        self.write(self.b)
        report, _ = self.sync(self.home)
        self.assertEqual((report['added'], self.servers(self.home)), (['fetch'], {'fetch': FETCH}))


if __name__ == '__main__':
    unittest.main()
