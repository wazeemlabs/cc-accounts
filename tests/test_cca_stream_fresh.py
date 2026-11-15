"""cca-stream's fresh start after a move: when the plugin asks for one and the
panel has nothing in flight, cca-stream ends with the child, and the panel
starts the conversation at its next message as it starts any, through cca on
the account recorded for it. The extension runs its whole startup then (the
account it shows, Remote Control, the plan's models, commands), which a child
cca-stream starts behind its back never gets."""
import tempfile
import unittest

from stream_fixtures import ID, user
from test_cca_stream import Supervised


class Fresh(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_every_child_is_told_cca_stream_can_end_for_a_fresh_start_and_only_a_relaunched_one_that_it_was(self):
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        s.send(user('hello'))
        s.next()
        s.close()
        first, second = s.starts()
        self.assertEqual((first['fresh'], first['resumed']), ('1', None))
        self.assertEqual((second['fresh'], second['resumed']), ('1', '1'))

    def test_a_fresh_start_asked_for_with_nothing_in_flight_ends_with_the_child(self):
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID} fresh\n'))
        self.assertEqual(s.next()['text'], f'switch:work {ID} fresh\n')
        self.assertEqual(s.process.wait(timeout=10), 0)
        self.assertEqual(len(s.starts()), 1)
        self.assertFalse(s.switch.exists())
        self.assertIn('starts it afresh', s.process.stderr.read().decode())

    def test_a_fresh_start_with_a_follow_up_relaunches_so_the_work_goes_on(self):
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID} fresh\n[cc-accounts] carry on\n'))
        s.next()
        self.assertEqual(s.next()['text'], '[cc-accounts] carry on')
        s.close()
        self.assertEqual(len(s.starts()), 2)

    def test_a_malformed_third_word_is_refused_and_the_session_ends_as_before(self):
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID} later\n'))
        s.next()
        self.assertEqual(s.process.wait(timeout=10), 0)
        self.assertIn('not "<account> <conversation id>', s.process.stderr.read().decode())


if __name__ == '__main__':
    unittest.main()
