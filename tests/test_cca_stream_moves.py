"""cca-stream after a move: it always starts a new child on the conversation,
so the panel keeps its process. 0.14.0 let cca-stream end with the child when
the plugin asked for a fresh start (`<account> <id> fresh`); the panel showed
that conversation as stopped until the next message. A plugin from before
0.15.0 may still ask, so the word is accepted and the move relaunches."""
import tempfile
import unittest

from stream_fixtures import ID, user
from test_cca_stream import Supervised


class Moves(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_move_an_older_plugin_asked_to_end_with_relaunches_the_conversation(self):
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID} fresh\n'))
        self.assertEqual(s.next()['text'], f'switch:work {ID} fresh\n')
        # Nothing reaches cca-stream until it has decided, so nothing is in flight.
        first, second = s.settled(2)
        s.send(user('hello'))
        self.assertEqual(s.next()['text'], 'hello')
        self.assertEqual(s.close(), 0)
        self.assertNotIn('--resume', first['start'])
        self.assertEqual(second['start'][-2:], ['--resume', ID])
        self.assertIn(f'resuming {ID} on account work', s.process.stderr.read().decode())

    def test_a_child_is_not_told_cca_stream_could_end_with_it_even_under_an_older_one(self):
        s = Supervised(self, [], env={'CCA_STREAM_FRESH': '1', 'CCA_STREAM_RESUMED': '1'})
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        s.send(user('hello'))
        s.next()
        s.close()
        for start in s.starts():
            self.assertEqual((start['fresh'], start['resumed']), (None, None))

    def test_a_malformed_third_word_is_refused_and_the_session_ends_as_before(self):
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID} later\n'))
        s.next()
        self.assertEqual(s.process.wait(timeout=10), 0)
        self.assertIn('not "<account> <conversation id>', s.process.stderr.read().decode())


if __name__ == '__main__':
    unittest.main()
