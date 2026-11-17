"""cca-stream and Remote Control across a move. The panel turns Remote Control
on with a `remote_control` request and keeps the bridge epoch of the answer;
afterwards it marks Remote Control off only on a `bridge_state` of `failed`
or `policy_disabled` that names that epoch. A bridge belongs to the account
of the process that opened it and ends with that process, so before this a
move left the panel showing Remote Control as connected while the new
process ran no bridge, and nobody could reach the session from claude.ai or
the phone. Run: python3 -m unittest discover -s tests"""
import tempfile
import unittest

from stream_fixtures import ID, control, user
from test_cca_stream import Supervised

ON = {'enabled': True, 'name': 'Wazeem Studio', 'reattach_session_id': 'cse_old', 'work_secret': 'secret',
      'keep_session_on_exit': True}


def remote_requests(received):
    return [message for message in received
            if message['type'] == 'control_request' and message['request']['subtype'] == 'remote_control']


class RemoteControlAcrossAMove(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def turn_on(self, s):
        s.send(control('rc-1', 'remote_control', **ON))
        answer = s.next()
        self.assertEqual(answer['response']['response']['bridge_epoch'], 1)

    def move(self, s):
        s.send(user(f'switch:work {ID}\n'))
        self.assertEqual(s.next()['text'], f'switch:work {ID}\n')
        s.settled(2)

    def test_a_move_turns_remote_control_on_again_in_the_new_process_without_the_old_accounts_session(self):
        s = Supervised(self, [])
        self.turn_on(s)
        self.move(s)
        s.send(user('hello'))
        self.assertEqual(s.next()['text'], 'hello')
        s.close()
        [again] = remote_requests(s.received(1))
        self.assertTrue(again['request_id'].startswith('cca-replay-'))
        self.assertEqual(again['request'], {'subtype': 'remote_control', 'enabled': True, 'name': 'Wazeem Studio'})

    def test_the_new_bridges_answer_is_not_shown_to_the_panel(self):
        s = Supervised(self, [])
        self.turn_on(s)
        self.move(s)
        s.send(user('hello'))
        self.assertEqual(s.next()['text'], 'hello')

    def test_the_new_bridges_state_reaches_the_panel_under_the_epoch_the_panel_knows(self):
        s = Supervised(self, [])
        self.turn_on(s)
        self.move(s)
        s.send(user('bridge:failed'))
        state = s.next()
        self.assertEqual((state['subtype'], state['state'], state['bridge_epoch']), ('bridge_state', 'failed', 1))

    def test_a_new_process_that_cannot_turn_remote_control_on_tells_the_panel_it_is_off(self):
        s = Supervised(self, [], env={'FAKE_RC_REFUSE': '1'})
        self.turn_on(s)
        self.move(s)
        state = s.next()
        self.assertEqual((state['type'], state['subtype'], state['state'], state['bridge_epoch']),
                         ('system', 'bridge_state', 'failed', 1))
        s.send(user('hello'))
        self.assertEqual(s.next()['text'], 'hello')

    def test_remote_control_the_panel_turned_off_stays_off_after_a_move(self):
        s = Supervised(self, [])
        self.turn_on(s)
        s.send(control('rc-2', 'remote_control', enabled=False))
        s.next()
        self.move(s)
        s.send(user('hello'))
        s.next()
        s.close()
        self.assertEqual(remote_requests(s.received(1)), [])

    def test_a_session_that_never_had_remote_control_gets_none_after_a_move(self):
        s = Supervised(self, [])
        self.move(s)
        s.send(user('hello'))
        s.next()
        s.close()
        self.assertEqual(remote_requests(s.received(1)), [])

    def test_a_request_the_panel_sent_during_the_move_reaches_the_new_process_alone(self):
        s = Supervised(self, [])
        self.turn_on(s)
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        s.send(control('rc-3', 'remote_control', enabled=False))
        self.assertEqual(s.next()['response']['request_id'], 'rc-3')
        s.close()
        self.assertEqual([message['request_id'] for message in remote_requests(s.received(1))], ['rc-3'])

    def test_after_the_panel_turns_it_on_again_the_new_bridges_epoch_is_its_own(self):
        s = Supervised(self, [])
        self.turn_on(s)
        self.move(s)
        s.send(control('rc-4', 'remote_control', enabled=True, name='Wazeem Studio'))
        self.assertEqual(s.next()['response']['response']['bridge_epoch'], 7)
        s.send(user('bridge:failed'))
        self.assertEqual(s.next()['bridge_epoch'], 7)


if __name__ == '__main__':
    unittest.main()
