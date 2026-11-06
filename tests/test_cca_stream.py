"""Tests for libexec/cca-stream, which keeps a VS Code session's process alive
across an account switch. Run: python3 -m unittest discover -s tests"""
import argparse
import importlib.machinery
import importlib.util
import io
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
import types
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
# reads, answers control requests, answers user messages, and on
# `switch:<text>` writes <text> to the switch file and exits, as the plugin's
# switch does. Run with --replay-user-messages it first echoes each user
# message it takes, as Claude Code does, except `ignore:` ones, which it reads
# and never takes, like a message still in the pipe when a process ends. The
# first child (not started with --resume) leaves control requests whose id
# starts `silent-` unanswered, like one in flight when a process ends; on
# `ask:<id>` a child asks the panel a permission question with that id.
FAKE = textwrap.dedent('''\
    import json, os, sys
    log = open(os.environ['FAKE_LOG'], 'a')
    def note(value):
        log.write(json.dumps(value) + '\\n'); log.flush()
    note({'start': sys.argv[2:], 'bin': sys.argv[1], 'child': os.environ.get('CCA_STREAM_CHILD'),
          'switch': os.environ.get('CLAUDE_ACCOUNT_SWITCH_FILE'), 'supervisor': os.environ.get('CCA_STREAM_PID')})
    echoes = '--replay-user-messages' in sys.argv
    first = '--resume' not in sys.argv
    for line in sys.stdin:
        message = json.loads(line)
        note({'got': message})
        if message['type'] == 'control_request':
            if first and message['request_id'].startswith('silent-'):
                continue
            print(json.dumps({'type': 'control_response', 'response': {'subtype': 'success',
                  'request_id': message['request_id'], 'response': {}}}), flush=True)
            continue
        if message['type'] != 'user':
            continue
        text = message['message']['content'][0]['text']
        if text.startswith('ask:'):
            print(json.dumps({'type': 'control_request', 'request_id': text[len('ask:'):],
                  'request': {'subtype': 'can_use_tool', 'tool_name': 'Bash'}}), flush=True)
        if text.startswith('ignore:'):
            continue
        if echoes and message['type'] == 'user':
            print(json.dumps({'type': 'user', 'uuid': message.get('uuid'), 'isReplay': True}), flush=True)
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


def user(text, uuid=None):
    message = {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]},
               'parent_tool_use_id': None, 'session_id': ID}
    return message if uuid is None else {**message, 'uuid': uuid}


def without_uuid(message):
    return {key: value for key, value in message.items() if key != 'uuid'}


def line(value):
    return (json.dumps(value) + '\n').encode()


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
    def test_drops_every_option_that_picks_a_point_in_the_conversation(self):
        self.assertEqual(stream.relaunch_args(['--verbose', '--resume', 'x', '--resume-session-at', 'm1',
                                               '--resume-drops-turn', '--from-pr', '12', '--debug'], ID),
                         ['--verbose', '--debug', '--resume', ID])
        self.assertTrue({'--resume-session-at', '--resume-drops-turn', '--from-pr'} <= stream.keep_args.CONVERSATION)

    def test_keeps_the_hidden_options_the_panel_passes_and_drops_a_prompt(self):
        panel = ['--output-format', 'stream-json', '--max-thinking-tokens=31999', '--permission-prompt-tool=stdio',
                 '--debug-to-stderr', '--enable-auth-status', '--replay-user-messages']
        self.assertEqual(stream.relaunch_args([*panel, f'--resume={ID}'], ID), [*panel, '--resume', ID])
        self.assertEqual(stream.relaunch_args(['--verbose', '--', 'a prompt'], ID), ['--verbose', '--resume', ID])

    def test_resumes_the_named_conversation_and_drops_whatever_chose_one_before(self):
        other = 'aaaaaaaa-1111-4222-8333-944455556666'
        self.assertEqual(stream.relaunch_args(['--verbose', f'--resume={other}', '--debug'], ID),
                         ['--verbose', '--debug', '--resume', ID])
        self.assertEqual(stream.relaunch_args(['-r', other, '--model', 'opus'], ID), ['--model', 'opus', '--resume', ID])
        self.assertEqual(stream.relaunch_args(['--session-id', other, '--fork-session', '-c', '--x'], ID),
                         ['--x', '--resume', ID])
        self.assertEqual(stream.relaunch_args([f'--session-id={other}'], ID), ['--resume', ID])
        self.assertEqual(stream.relaunch_args([], ID), ['--resume', ID])


class Unread(unittest.TestCase):
    def test_forgets_a_message_once_claude_code_echoes_it_and_hands_back_the_rest_in_order(self):
        unread = stream.Unread(True)
        for name in ('a', 'b', 'c'):
            unread.sending(line(user(name, f'u-{name}')))
        unread.echoed(line({'type': 'user', 'uuid': 'u-b', 'isReplay': True}))
        self.assertEqual(unread.take(), [line(user('a', 'u-a')), line(user('c', 'u-c'))])
        self.assertEqual(unread.take(), [])

    def test_only_an_echo_counts_and_only_user_messages_with_a_uuid_are_kept(self):
        unread = stream.Unread(True)
        unread.sending(line(user('a', 'u-a')))
        unread.sending(line(user('no uuid')))
        unread.sending(line(control('p1', 'interrupt')))
        unread.sending(b'not json "user"\n')
        unread.echoed(line({'type': 'user', 'uuid': 'u-a'}))
        unread.echoed(line({'type': 'assistant', 'uuid': 'u-a', 'isReplay': True}))
        self.assertEqual(unread.take(), [line(user('a', 'u-a'))])

    def test_a_message_that_never_reached_the_child_is_forgotten_and_an_early_echo_still_counts(self):
        unread = stream.Unread(True)
        unread.forget(unread.sending(line(user('a', 'u-a'))))
        unread.sending(line(user('b', 'u-b')))
        unread.echoed(line({'type': 'user', 'uuid': 'u-b', 'isReplay': True}))
        self.assertEqual(unread.take(), [])

    def test_keeps_nothing_when_the_child_does_not_echo(self):
        unread = stream.Unread(False)
        unread.sending(line(user('a', 'u-a')))
        self.assertEqual(unread.take(), [])

    def test_the_follow_up_carries_a_uuid_of_its_own(self):
        first, second = (json.loads(stream.user_message('Carry on.', ID)) for _ in range(2))
        self.assertEqual(without_uuid(first), user('Carry on.'))
        self.assertNotEqual(first['uuid'], second['uuid'])


class InProcess(unittest.TestCase):
    """The supervisor's parts, driven one step at a time."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.switch = pathlib.Path(self.tmp.name) / 'switch'
        options = argparse.Namespace(switch=str(self.switch), cca='/x/cca', bin='/x/claude')
        self.supervisor = stream.Supervisor(options, [])
        self.addCleanup(os.close, self.supervisor.release_read)

    def tearDown(self):
        self.tmp.cleanup()

    def release(self):
        """SIGUSR1 once, then pump_releases until the pipe is drained."""
        self.supervisor.release(signal.SIGUSR1, None)
        os.close(self.supervisor.release_write)
        self.supervisor.pump_releases()

    def test_a_withdrawn_switch_releases_what_was_held_to_the_child_still_running(self):
        child = types.SimpleNamespace(stdin=io.BytesIO())
        self.supervisor.child = child
        self.supervisor.held = [line(user('held'))]
        self.release()
        self.assertEqual(child.stdin.getvalue(), line(user('held')))
        self.assertEqual(self.supervisor.held, [])

    def test_a_release_while_the_switch_file_stands_keeps_holding(self):
        self.switch.write_text(f'work {ID}\n')
        child = types.SimpleNamespace(stdin=io.BytesIO())
        self.supervisor.child = child
        self.supervisor.held = [line(user('held'))]
        self.release()
        self.assertEqual(child.stdin.getvalue(), b'')
        self.assertEqual(self.supervisor.held, [line(user('held'))])

    def test_only_the_current_childs_output_reaches_the_panel(self):
        os.close(self.supervisor.release_write)
        supervisor = self.supervisor
        supervisor.out = io.BytesIO()
        old, new = (types.SimpleNamespace(stdout=io.BytesIO(b'{"type":"assistant"}\n')) for _ in range(2))
        supervisor.output_child = new
        supervisor.pump_stdout(old)
        self.assertEqual(supervisor.out.getvalue(), b'')
        supervisor.pump_stdout(new)
        self.assertEqual(supervisor.out.getvalue(), b'{"type":"assistant"}\n')


class SetupNote(unittest.TestCase):
    def test_a_line_that_is_json_but_not_an_object_is_passed_over(self):
        setup = stream.Setup()
        for text in (b'["control_request"]\n', b'"control_request"\n', b'{"type": "control_request", "request": 3}\n'):
            setup.note(text)
        self.assertEqual(setup.replay(), [])


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
        self.assertEqual(start['supervisor'], str(s.process.pid))

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
        self.assertEqual(without_uuid(got[2]), user('Carry on.'))
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

    def test_a_message_the_old_child_never_took_is_sent_to_the_new_one_after_the_follow_up(self):
        s = Supervised(self, ['--replay-user-messages'])
        s.send(user('hello', 'u-1'))
        self.assertEqual(s.next(), {'type': 'user', 'uuid': 'u-1', 'isReplay': True})
        s.next()
        s.send(user('ignore:lost', 'u-2'))
        s.send(user(f'switch:work {ID}\nCarry on.\n', 'u-3'))
        self.assertEqual(s.next()['uuid'], 'u-3')
        s.next()
        # The new child takes the follow-up, then the message the old one never did.
        follow_up = s.next()
        self.assertEqual(follow_up['isReplay'], True)
        self.assertEqual(s.next(), {'type': 'assistant', 'text': 'Carry on.'})
        s.close()
        got = s.received(1)
        self.assertEqual([without_uuid(m) for m in got], [user('Carry on.'), user('ignore:lost')])
        self.assertEqual(got[1]['uuid'], 'u-2')

    def success(self, request_id):
        return {'type': 'control_response', 'response': {'subtype': 'success', 'request_id': request_id, 'response': {}}}

    def test_a_question_the_old_child_never_answered_is_answered_by_the_new_one(self):
        s = Supervised(self, [])
        s.send(control('silent-q', 'mcp_status'))
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        self.assertEqual(s.next(), self.success('silent-q'))
        s.close()
        self.assertEqual(s.received(1), [control('silent-q', 'mcp_status')])

    def test_an_interrupt_the_old_child_never_answered_is_answered_for_it(self):
        # Ending the process ended the turn the interrupt was for.
        s = Supervised(self, [])
        s.send(control('silent-i', 'interrupt'))
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        self.assertEqual(s.next(), self.success('silent-i'))
        s.send(user('next'))
        self.assertEqual(s.next(), {'type': 'assistant', 'text': 'next'})
        s.close()
        self.assertEqual(s.received(1), [user('next')])

    def test_a_setting_the_old_child_never_answered_is_replayed_under_its_own_id(self):
        s = Supervised(self, [])
        s.send(control('silent-m', 'set_permission_mode', mode='plan'))
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        self.assertEqual(s.next(), self.success('silent-m'))
        s.close()
        self.assertEqual(s.received(1), [control('silent-m', 'set_permission_mode', mode='plan')])

    def test_a_question_the_old_child_left_open_is_withdrawn_from_the_panel(self):
        s = Supervised(self, [])
        s.send(user('ask:perm-1'))
        self.assertEqual(s.next()['request_id'], 'perm-1')
        s.next()
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        self.assertEqual(s.next(), {'type': 'control_cancel_request', 'request_id': 'perm-1'})
        s.close()

    def test_a_question_the_panel_answered_is_not_withdrawn(self):
        s = Supervised(self, [])
        s.send(user('ask:perm-2'))
        s.next()
        s.next()
        s.send({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': 'perm-2', 'response': {}}})
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        s.send(user('next'))
        self.assertEqual(s.next(), {'type': 'assistant', 'text': 'next'})
        s.close()

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
