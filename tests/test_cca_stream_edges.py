"""cca-stream edges the 2026-11-15 review found: large panel lines, settings and messages around a switch, and a new child that answers as it reads."""
import json
import queue
import tempfile
import unittest

from stream_fixtures import ID, WAIT, control, user
from test_cca_stream import Supervised


class Edges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_lines_held_across_a_switch_reach_the_new_child_when_it_answers_each_one(self):
        # The panel keeps sending while the switch is pending (the lines are
        # held); the new child answers each line it reads, as Claude Code
        # echoes a user message (with --replay-user-messages, content and all).
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        big = 'x' * 10000
        count = 30
        for n in range(count):
            s.send(user(f'{n}:{big}'))
        got = []
        try:
            for _ in range(count):
                got.append(s.next()['text'][:3])
        except queue.Empty:
            pass
        self.assertEqual(len(got), count, f'only {len(got)} of {count} answers reached the panel')

    def test_a_setting_sent_while_a_switch_is_pending_reaches_the_new_child_once(self):
        s = Supervised(self, [])
        s.send(user(f'switch:work {ID}\n'))
        s.next()
        s.send(control('p9', 'set_model', model='opus'))
        self.assertEqual(s.next()['response']['request_id'], 'p9')
        s.close()
        models = [m for m in s.received(1) if m['type'] == 'control_request' and m['request']['subtype'] == 'set_model']
        self.assertEqual(len(models), 1, json.dumps(models))

    def test_a_queued_message_the_panel_cancelled_is_not_sent_again_after_a_switch(self):
        s = Supervised(self, ['--replay-user-messages'])
        # Queued behind a turn, never taken, then cancelled by the panel.
        s.send(user('ignore:cancelled later', 'u-9'))
        s.send(control('c1', 'cancel_async_message', message_uuid='u-9'))
        self.assertEqual(s.next()['response']['request_id'], 'c1')
        s.send(user(f'switch:work {ID}\n', 'u-10'))
        s.next()
        s.next()
        s.send(user('next', 'u-11'))
        while s.next().get('text') != 'next':
            pass
        s.close()
        resent = [m.get('uuid') for m in s.received(1) if m['type'] == 'user']
        self.assertNotIn('u-9', resent)

    def test_reading_a_large_panel_line_takes_time_linear_in_its_size(self):
        import os, threading, time
        from stream_fixtures import stream

        def seconds(size):
            r, w = os.pipe()
            data = b'"' + b'a' * size + b'"\n'

            def writer():
                view = memoryview(data)
                while view:
                    view = view[os.write(w, view[:65536]):]
                os.close(w)
            t = threading.Thread(target=writer)
            t.start()
            start = time.perf_counter()
            list(stream.read_lines(r))
            took = time.perf_counter() - start
            t.join()
            os.close(r)
            return took
        small, large = seconds(4 << 20), seconds(32 << 20)
        self.assertLess(large, small * 8 * 2, f'4 MB: {small:.2f}s, 32 MB: {large:.2f}s')


if __name__ == '__main__':
    unittest.main()
