"""Tests for libexec/cca-stream-lines: what cca-stream keeps of the panel's
and Claude Code's lines across a switch. Run: python3 -m unittest discover -s tests"""
import json
import unittest

from stream_fixtures import ID, control, line, stream, user, without_uuid


class Unread(unittest.TestCase):
    def test_forgets_a_message_once_claude_code_echoes_it_and_hands_back_the_rest_in_order(self):
        unread = stream.protocol.Unread(True)
        for name in ('a', 'b', 'c'):
            unread.sending(line(user(name, f'u-{name}')))
        unread.echoed(line({'type': 'user', 'uuid': 'u-b', 'isReplay': True}))
        self.assertEqual(unread.take(), [line(user('a', 'u-a')), line(user('c', 'u-c'))])
        self.assertEqual(unread.take(), [])

    def test_only_an_echo_counts_and_only_user_messages_with_a_uuid_are_kept(self):
        unread = stream.protocol.Unread(True)
        unread.sending(line(user('a', 'u-a')))
        unread.sending(line(user('no uuid')))
        unread.sending(line(control('p1', 'interrupt')))
        unread.sending(b'not json "user"\n')
        unread.echoed(line({'type': 'user', 'uuid': 'u-a'}))
        unread.echoed(line({'type': 'assistant', 'uuid': 'u-a', 'isReplay': True}))
        self.assertEqual(unread.take(), [line(user('a', 'u-a'))])

    def test_a_message_that_never_reached_the_child_is_forgotten_and_an_early_echo_still_counts(self):
        unread = stream.protocol.Unread(True)
        unread.forget(unread.sending(line(user('a', 'u-a'))))
        unread.sending(line(user('b', 'u-b')))
        unread.echoed(line({'type': 'user', 'uuid': 'u-b', 'isReplay': True}))
        self.assertEqual(unread.take(), [])

    def test_keeps_nothing_when_the_child_does_not_echo(self):
        unread = stream.protocol.Unread(False)
        unread.sending(line(user('a', 'u-a')))
        self.assertEqual(unread.take(), [])

    def test_the_follow_up_carries_a_uuid_of_its_own(self):
        first, second = (json.loads(stream.protocol.user_message('Carry on.', ID)) for _ in range(2))
        self.assertEqual(without_uuid(first), user('Carry on.'))
        self.assertNotEqual(first['uuid'], second['uuid'])


class Open(unittest.TestCase):
    def test_keeps_each_sides_requests_until_the_other_answers_or_they_are_withdrawn(self):
        opened = stream.protocol.Open()
        for request_id in ('q1', 'q2', 'q3'):
            opened.sending(line(control(request_id, 'mcp_status')))
        opened.sending(line(control('cca-replay-1', 'initialize')))
        opened.from_child(line({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': 'q1'}}))
        opened.from_panel(line({'type': 'control_cancel_request', 'request_id': 'q2'}))
        opened.from_child(line(control('perm-1', 'can_use_tool')))
        opened.from_child(line(control('perm-2', 'can_use_tool')))
        opened.from_child(line(control('perm-3', 'can_use_tool')))
        opened.from_panel(line({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': 'perm-1'}}))
        opened.from_child(line({'type': 'control_cancel_request', 'request_id': 'perm-2'}))
        panel, child = opened.take()
        self.assertEqual(list(panel), ['q3'])
        self.assertEqual(child, {'perm-3'})
        self.assertEqual(opened.take(), ({}, set()))

    def test_a_request_that_never_reached_the_child_is_not_kept(self):
        opened = stream.protocol.Open()
        opened.forget(opened.sending(line(control('q1', 'mcp_status'))))
        opened.forget(opened.sending(line(user('hi'))))
        self.assertEqual(opened.take(), ({}, set()))


class SetupNote(unittest.TestCase):
    def test_a_line_that_is_json_but_not_an_object_is_passed_over(self):
        setup = stream.protocol.Setup()
        for text in (b'["control_request"]\n', b'"control_request"\n', b'{"type": "control_request", "request": 3}\n'):
            setup.note(text)
        self.assertEqual(setup.replay(), [])


if __name__ == '__main__':
    unittest.main()
