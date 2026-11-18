"""prune.py --session --since: a session asks at every turn's end, and the
prune looks at the conversation only when its transcript has a compact
boundary the tails file has not seen. The session cannot say so itself: where
an organization's plugin sends `session.compact` past a person's plugins, it
never hears of its own compactions (2026-11-18: a transcript two compactions
old kept 5.8 MB of rows from before the last).
Run: python3 -m unittest discover -s tests"""
import json
import os
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_prune import BIG, SESSION, Transcript, boundary, message, screenshot  # noqa: E402


class Since(Transcript):
    def setUp(self):
        super().setUp()
        self.tails = self.projects.parent / 'tails.json'

    def since(self, *args):
        return self.cli(*(args or ('--session', SESSION)), '--since', str(self.tails))

    def append(self, rows, end='\n'):
        with open(self.path, 'a') as out:
            out.write('\n'.join(json.dumps(row) for row in rows) + end)

    def pruned(self, done):
        self.assertEqual(done.returncode, 0, done.stderr)
        return [line.split(':')[0] for line in done.stdout.splitlines()]

    def test_a_transcript_never_seen_is_looked_at_whole(self):
        self.write([message('a', None, text=BIG), boundary('k'), message('b', 'k')])
        self.assertEqual(self.pruned(self.since()), [str(self.path)])
        self.assertEqual(self.kinds(), ['k', 'b'])

    def test_rows_since_the_last_look_with_no_compaction_among_them_prune_nothing(self):
        self.write([message('a', None)])
        self.assertEqual(self.pruned(self.since()), [])
        # Images enough to be worth a rewrite, which only a look would find.
        self.append([screenshot(f'i{n}', 'a', 'A' * 600_000) for n in range(9)])
        before = self.path.read_bytes()
        self.assertEqual(self.pruned(self.since()), [])
        self.assertEqual(self.path.read_bytes(), before)

    def test_a_compaction_since_the_last_look_prunes_the_conversation_and_its_subagents(self):
        self.write([message('a', None, text=BIG)])
        subagent = self.write([screenshot(f'i{n}', None, 'A' * 600_000) for n in range(9)],
                              self.folder / SESSION / 'subagents' / 'agent-a1.jsonl')
        self.assertEqual(self.pruned(self.since()), [str(subagent)])
        self.append([boundary('k'), message('b', 'k')])
        self.assertEqual(self.pruned(self.since()), [str(self.path)])
        self.assertEqual(self.kinds(), ['k', 'b'])

    def test_each_compaction_is_found_once(self):
        self.write([message('a', None, text=BIG), boundary('k'), message('b', 'k')])
        self.since()
        self.since()
        self.append([message('c', 'b', text=BIG)])
        self.assertEqual(self.pruned(self.since()), [])
        self.append([boundary('k2'), message('d', 'k2')])
        self.assertEqual(self.pruned(self.since()), [str(self.path)])
        self.assertEqual(self.kinds(), ['k2', 'd'])

    def test_a_boundary_half_written_at_a_look_is_found_at_the_next(self):
        self.write([message('a', None, text=BIG)])
        self.since()
        whole = json.dumps(boundary('k')) + '\n'
        with open(self.path, 'a') as out:
            out.write(whole[:60])
        self.assertEqual(self.pruned(self.since()), [])
        with open(self.path, 'a') as out:
            out.write(whole[60:])
        self.assertEqual(self.pruned(self.since()), [str(self.path)])
        self.assertEqual(self.kinds(), ['k'])

    def test_a_transcript_another_writer_replaced_is_looked_at_whole_again(self):
        self.write([message('a', None)])
        self.since()
        # As Claude Code's own compaction renames a new file over the path.
        other = self.write([message('a', None, text=BIG), boundary('k'), message('b', 'k')], self.folder / 'new.tmp')
        os.replace(other, self.path)
        self.assertEqual(self.pruned(self.since()), [str(self.path)])

    def test_a_transcript_cut_shorter_than_the_last_look_is_looked_at_whole_again(self):
        self.write([message('x', None), message('y', 'x'), message('z', 'y')])
        self.since()
        # As Claude Code removes a row: the same file, truncated and rewritten.
        with open(self.path, 'r+') as out:
            out.truncate(0)
            out.write(''.join(json.dumps(row) + '\n' for row in [boundary('k')]))
        self.assertEqual(self.pruned(self.since()), [])
        tail = json.loads(self.tails.read_text())[str(self.path)]
        self.assertEqual(tail[1], self.path.stat().st_size)

    def test_the_words_of_a_boundary_inside_a_message_are_no_compaction(self):
        self.write([message('a', None, text=BIG)])
        self.since()
        self.append([message('b', 'a', text='"subtype":"compact_boundary"')])
        self.assertEqual(self.pruned(self.since()), [])
        self.assertEqual(self.kinds(), ['a', 'b'])

    def test_a_subagents_own_compaction_inside_the_conversation_is_not_the_conversations(self):
        self.write([message('a', None, text=BIG)])
        self.since()
        self.append([boundary('side', side=True)])
        self.assertEqual(self.pruned(self.since()), [])
        self.assertEqual(self.kinds(), ['a', 'side'])

    def test_a_look_that_passes_writes_no_prune_state(self):
        self.write([message('a', None)])
        self.since()
        state = self.projects.parent / 'state.json'
        state.unlink()
        self.since()
        self.assertFalse(state.exists())

    def test_all_forgets_the_tail_of_a_transcript_that_is_gone(self):
        self.write([message('a', None)])
        gone = self.write([message('a', None)], self.folder / 'gone.jsonl')
        self.tails.write_text(json.dumps({str(gone): [gone.stat().st_ino, 1], str(self.path): [self.path.stat().st_ino, 1]}))
        gone.unlink()
        self.assertEqual(self.pruned(self.since('--all')), [])
        self.assertEqual(set(json.loads(self.tails.read_text())), {str(self.path)})

    def test_a_tails_file_that_is_not_one_is_reported_and_every_transcript_looked_at_again(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        self.tails.write_text('not json')
        done = self.since()
        self.assertEqual(self.pruned(done), [str(self.path)])
        self.assertIn('is not a tails file', done.stderr)
        self.assertEqual(list(json.loads(self.tails.read_text())), [])

    def test_without_since_a_session_is_pruned_as_before(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        self.since()
        self.append([message('b', 'k', text=BIG), boundary('k2')])
        self.assertEqual(self.pruned(self.cli('--session', SESSION)), [str(self.path)])


if __name__ == '__main__':
    unittest.main()
