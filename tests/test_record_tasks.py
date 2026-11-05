"""Tests for plugin/hooks/record-tasks.py, the plugin's Stop hook.
Run: python3 -m unittest discover -s tests"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
PLUGIN = HERE.parent / 'plugin'
SCRIPT = PLUGIN / 'hooks' / 'record-tasks.py'
SESSION = '0f4a6c1e-1111-4222-8333-944455556666'
SHELL = {'id': 'b1', 'type': 'shell', 'status': 'running', 'description': 'npm test', 'command': 'npm test'}


class RecordTasks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / 'accounts'
        self.root.mkdir()
        (self.root / 'accounts.tsv').write_text('1\t/home/me/.claude\n')
        self.record = self.root / 'background' / SESSION

    def tearDown(self):
        self.tmp.cleanup()

    def hook(self, hook_input, root=None):
        text = hook_input if isinstance(hook_input, str) else json.dumps(hook_input)
        env = {**os.environ, 'CCA_ROOT': str(root or self.root)}
        return subprocess.run([sys.executable, '-I', str(SCRIPT)], input=text, env=env,
                              capture_output=True, text=True, check=False)

    def stop(self, tasks):
        return {'session_id': SESSION, 'hook_event_name': 'Stop', 'stop_hook_active': False,
                'background_tasks': tasks, 'session_crons': []}

    def test_saves_the_work_in_flight_with_only_the_fields_the_plugin_reads(self):
        done = self.hook(self.stop([SHELL]))
        self.assertEqual((done.returncode, done.stderr), (0, ''))
        self.assertEqual(json.loads(self.record.read_text()),
                         {'tasks': [{'id': 'b1', 'type': 'shell', 'status': 'running', 'description': 'npm test'}],
                          'crons': []})

    def test_saves_the_scheduled_wakeups_a_switch_would_drop(self):
        loop = {'id': 'c1', 'schedule': '*/5 * * * *', 'recurring': True, 'prompt': 'check CI', 'createdAt': 1}
        done = self.hook({**self.stop([]), 'session_crons': [loop]})
        self.assertEqual((done.returncode, done.stderr), (0, ''))
        self.assertEqual(json.loads(self.record.read_text())['crons'],
                         [{'id': 'c1', 'schedule': '*/5 * * * *', 'recurring': True, 'prompt': 'check CI'}])

    def test_an_older_claude_code_without_wakeups_saves_none(self):
        hook_input = self.stop([])
        del hook_input['session_crons']
        self.assertEqual(self.hook(hook_input).returncode, 0)
        self.assertEqual(json.loads(self.record.read_text()), {'tasks': [], 'crons': []})

    def test_an_empty_list_replaces_the_mark_a_turn_left(self):
        self.record.parent.mkdir()
        self.record.write_text('{"turn":"t1"}\n')
        self.assertEqual(self.hook(self.stop([])).returncode, 0)
        self.assertEqual(json.loads(self.record.read_text()), {'tasks': [], 'crons': []})
        self.assertEqual(os.listdir(self.record.parent), [SESSION])

    def test_writes_nothing_where_cca_is_not_set_up(self):
        (self.root / 'accounts.tsv').unlink()
        done = self.hook(self.stop([SHELL]))
        self.assertEqual(done.returncode, 0)
        self.assertFalse(self.record.parent.exists())

    def test_a_claude_code_that_lists_no_tasks_is_reported(self):
        hook_input = self.stop([])
        del hook_input['background_tasks']
        done = self.hook(hook_input)
        self.assertEqual(done.returncode, 1)
        self.assertIn('does not list background tasks', done.stderr)
        self.assertFalse(self.record.exists())

    def test_refuses_input_that_is_not_a_stop_hooks(self):
        for bad in ('not json', '[]', {**self.stop([]), 'session_id': '../../etc'},
                    self.stop('b1'), self.stop([{'type': 'shell'}]),
                    {**self.stop([]), 'session_crons': 'c1'}, {**self.stop([]), 'session_crons': [{'id': 'c1'}]}):
            with self.subTest(bad=bad):
                done = self.hook(bad)
                self.assertEqual(done.returncode, 1)
                self.assertTrue(done.stderr.startswith('cc-accounts: '))
                self.assertFalse(self.record.exists())

    def test_the_plugin_runs_it_on_stop(self):
        hooks = json.loads((PLUGIN / 'hooks' / 'hooks.json').read_text())
        commands = [h['command'] for entry in hooks['hooks']['Stop'] for h in entry['hooks']]
        self.assertEqual(commands, ['python3 "${CLAUDE_PLUGIN_ROOT}/hooks/record-tasks.py"'])


if __name__ == '__main__':
    unittest.main()
