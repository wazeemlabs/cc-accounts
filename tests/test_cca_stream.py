"""Tests for libexec/cca-stream, which keeps a VS Code session's process alive
across an account switch. Run: python3 -m unittest discover -s tests"""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import queue
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'libexec' / 'cca-stream'
ID = '0f4a6c1e-1111-4222-8333-944455556666'
WAIT = 10

_loader = importlib.machinery.SourceFileLoader('cca_stream', str(SCRIPT))
_spec = importlib.util.spec_from_loader('cca_stream', _loader)
stream = importlib.util.module_from_spec(_spec)
_loader.exec_module(stream)

# Stands in for `cca <claude>`: logs how it was started and every line it
# reads, answers control requests, echoes user messages, and on `switch:<text>`
# writes <text> to the switch file and exits, as the plugin's switch does.
FAKE = textwrap.dedent('''\
    import json, os, sys
    log = open(os.environ['FAKE_LOG'], 'a')
    def note(value):
        log.write(json.dumps(value) + '\\n'); log.flush()
    note({'start': sys.argv[2:], 'bin': sys.argv[1], 'child': os.environ.get('CCA_STREAM_CHILD'),
          'switch': os.environ.get('CLAUDE_ACCOUNT_SWITCH_FILE')})
    for line in sys.stdin:
        message = json.loads(line)
        note({'got': message})
        if message['type'] == 'control_request':
            print(json.dumps({'type': 'control_response', 'response': {'subtype': 'success',
                  'request_id': message['request_id'], 'response': {}}}), flush=True)
            continue
        text = message['message']['content'][0]['text'] if message['type'] == 'user' else ''
        if text.startswith('switch:'):
            with open(os.environ['CLAUDE_ACCOUNT_SWITCH_FILE'], 'w') as handle:
                handle.write(text[len('switch:'):])
        print(json.dumps({'type': 'assistant', 'text': text}), flush=True)
        if text.startswith('switch:'):
            sys.exit(0)
        if text.startswith('exit:'):
            sys.exit(int(text[len('exit:'):]))
    sys.exit(0)
''')


def user(text):
    return {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]},
            'parent_tool_use_id': None, 'session_id': ID}


def control(request_id, subtype, **fields):
    return {'type': 'control_request', 'request_id': request_id, 'request': {'subtype': subtype, **fields}}


class Supervised:
    """cca-stream over the fake child, with its stdout read on a thread."""

    def __init__(self, test, args):
        self.tmp = test.tmp
        self.log = pathlib.Path(self.tmp.name) / 'log'
        self.switch = pathlib.Path(self.tmp.name) / 'switch'
        fake = pathlib.Path(self.tmp.name) / 'fake-cca'
        fake.write_text(f'#!{sys.executable}\n{FAKE}')
        fake.chmod(0o755)
        env = {**os.environ, 'FAKE_LOG': str(self.log)}
        env.pop('CCA_STREAM_CHILD', None)
        self.process = subprocess.Popen(
            [sys.executable, '-I', str(SCRIPT), '--switch', str(self.switch), '--cca', str(fake), '--bin', '/x/claude',
             '--', *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        test.addCleanup(self._cleanup)

    def _cleanup(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=WAIT)
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            pipe.close()

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(json.loads(line))

    def send(self, value):
        self.process.stdin.write((json.dumps(value) + '\n').encode())
        self.process.stdin.flush()

    def next(self):
        return self.lines.get(timeout=WAIT)

    def close(self):
        self.process.stdin.close()
        return self.process.wait(timeout=WAIT)

    def logged(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def starts(self):
        return [entry for entry in self.logged() if 'start' in entry]

    def received(self, start):
        """What the child started `start`-th (0-based) read."""
        seen, out = -1, []
        for entry in self.logged():
            if 'start' in entry:
                seen += 1
            elif seen == start:
                out.append(entry['got'])
        return out


class RelaunchArgs(unittest.TestCase):
    def test_resumes_the_named_conversation_and_drops_whatever_chose_one_before(self):
        other = 'aaaaaaaa-1111-4222-8333-944455556666'
        self.assertEqual(stream.relaunch_args(['--verbose', f'--resume={other}', '--debug'], ID),
                         ['--verbose', '--debug', '--resume', ID])
        self.assertEqual(stream.relaunch_args(['-r', other, '--model', 'opus'], ID), ['--model', 'opus', '--resume', ID])
        self.assertEqual(stream.relaunch_args(['--session-id', other, '--fork-session', '-c', '--x'], ID),
                         ['--x', '--resume', ID])
        self.assertEqual(stream.relaunch_args([f'--session-id={other}'], ID), ['--resume', ID])
        self.assertEqual(stream.relaunch_args([], ID), ['--resume', ID])


class ReadSwitch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = pathlib.Path(self.tmp.name) / 'switch'

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_file_or_an_empty_one_is_no_request(self):
        self.assertIsNone(stream.read_switch(str(self.file)))
        self.file.write_text('\n')
        self.assertIsNone(stream.read_switch(str(self.file)))

    def test_reads_the_account_the_conversation_and_the_follow_up(self):
        self.file.write_text(f'work {ID}\n')
        self.assertEqual(stream.read_switch(str(self.file)), ('work', ID, ''))
        self.file.write_text(f'work {ID}\nCarry on.\nSecond line.\n')
        self.assertEqual(stream.read_switch(str(self.file)), ('work', ID, 'Carry on.\nSecond line.'))

    def test_refuses_a_request_without_a_conversation_id(self):
        for text in ('work\n', 'work not-an-id\n', f'work {ID} extra\n'):
            self.file.write_text(text)
            with self.assertRaises(ValueError):
                stream.read_switch(str(self.file))


class Supervisor(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_passes_lines_both_ways_and_exits_with_the_childs_status(self):
        s = Supervised(self, ['--verbose'])
        s.send(user('hello'))
        self.assertEqual(s.next(), {'type': 'assistant', 'text': 'hello'})
        s.send(user('exit:5'))
        self.assertEqual(s.next(), {'type': 'assistant', 'text': 'exit:5'})
        self.assertEqual(s.process.wait(timeout=WAIT), 5)
        start = s.starts()[0]
        self.assertEqual((start['bin'], start['start'], start['child']), ('/x/claude', ['--verbose'], '1'))
        self.assertEqual(start['switch'], str(s.switch))

    def test_the_panel_closing_stdin_ends_the_session(self):
        s = Supervised(self, [])
        s.send(user('hi'))
        s.next()
        self.assertEqual(s.close(), 0)
        self.assertEqual(len(s.starts()), 1)

    def test_a_switch_reopens_the_conversation_with_the_panels_setup_and_the_follow_up(self):
        s = Supervised(self, ['--verbose', '--resume=aaaaaaaa-1111-4222-8333-944455556666'])
        initialize = control('p1', 'initialize', hooks={'Stop': []})
        s.send(initialize)
        self.assertEqual(s.next()['response']['request_id'], 'p1')
        s.send(control('p2', 'set_permission_mode', mode='plan'))
        s.next()
        s.send(control('p3', 'set_permission_mode', mode='auto'))
        s.next()
        s.send(control('p4', 'interrupt'))
        s.next()
        s.send(user(f'switch:work {ID}\nCarry on.\n'))
        self.assertEqual(s.next(), {'type': 'assistant', 'text': f'switch:work {ID}\nCarry on.\n'})
        # The new child's answers to the replays never reach the panel; its
        # answer to the follow-up does, and so does what the panel sends next.
        self.assertEqual(s.next(), {'type': 'assistant', 'text': 'Carry on.'})
        s.send(user('next'))
        self.assertEqual(s.next(), {'type': 'assistant', 'text': 'next'})
        self.assertEqual(s.close(), 0)
        starts = s.starts()
        self.assertEqual(starts[1]['start'], ['--verbose', '--resume', ID])
        got = s.received(1)
        self.assertEqual([m['type'] for m in got], ['control_request', 'control_request', 'user', 'user'])
        self.assertEqual(got[0]['request'], initialize['request'])
        self.assertEqual(got[1]['request'], {'subtype': 'set_permission_mode', 'mode': 'auto'})
        self.assertTrue(got[0]['request_id'].startswith('cca-replay-'))
        self.assertNotEqual(got[0]['request_id'], got[1]['request_id'])
        self.assertEqual(got[2], user('Carry on.'))
        self.assertFalse(s.switch.exists())
        self.assertIn(f'cca: resuming {ID} on account work', s.process.stderr.read().decode())

    def test_a_switch_without_a_follow_up_sends_nothing_of_its_own(self):
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        s.send(user('next'))
        self.assertEqual(s.next(), {'type': 'assistant', 'text': 'next'})
        s.close()
        self.assertEqual(s.received(1), [user('next')])

    def test_a_panel_ui_detach_drops_the_attach_from_the_replay(self):
        s = Supervised(self, [])
        s.send(control('p1', 'ui_attach', surface='vscode'))
        s.next()
        s.send(control('p2', 'ui_detach'))
        s.next()
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        s.send(user('next'))
        s.next()
        s.close()
        self.assertEqual(s.received(1), [user('next')])

    def test_a_malformed_switch_request_ends_the_session_with_the_childs_status(self):
        s = Supervised(self, [])
        s.send(user('switch:work nope\n'))
        s.next()
        self.assertEqual(s.process.wait(timeout=WAIT), 0)
        self.assertEqual(len(s.starts()), 1)
        self.assertIn('not "<account> <conversation id>"', s.process.stderr.read().decode())

    def test_a_termination_signal_reaches_the_child_and_no_switch_follows(self):
        s = Supervised(self, [])
        s.send(user('hi'))
        s.next()
        s.switch.write_text(f'work {ID}\n')
        s.process.send_signal(signal.SIGTERM)
        self.assertEqual(s.process.wait(timeout=WAIT), 128 + signal.SIGTERM)
        self.assertEqual(len(s.starts()), 1)


if __name__ == '__main__':
    unittest.main()
