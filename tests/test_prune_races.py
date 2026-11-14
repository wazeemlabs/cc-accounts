"""prune.py against Claude Code's own rewrites of a transcript, which it can
make while a prune runs: performCompactTranscript renames a new file over the
path, and performRemoveByUuid truncates the file in place and writes rows back
(2026-11-15 review). The prune leaves such a transcript as the other writer
made it, and looks at it again on the next run."""
import json
import os
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_prune import BIG, Transcript, blob, boundary, message, prune, request  # noqa: E402


class AnotherWriter(Transcript):
    def lines(self):
        good, bad = [], []
        for line in self.path.read_text().splitlines():
            try:
                good.append(json.loads(line).get('uuid'))
            except ValueError:
                bad.append(line[:50])
        return good, bad

    def test_a_file_renamed_over_the_transcript_meanwhile_is_left_with_every_row_written_to_it(self):
        self.write([message('a', None, text=BIG), boundary('k'), message('b', 'k')])
        scan = prune.scan

        def scan_then_rename_over(source, size):
            found = scan(source, size)
            tmp = f'{self.path}.compact.tmp.x'
            with open(tmp, 'w') as out:
                out.write(json.dumps(boundary('k')) + '\n' + json.dumps(message('b', 'k')) + '\n')
            os.replace(tmp, self.path)
            with open(self.path, 'a') as out:
                out.write(json.dumps(message('after', 'b')) + '\n')
            return found

        with mock.patch.object(prune, 'scan', scan_then_rename_over):
            outcome = prune.prune(str(self.path), now=10 ** 10)
        # Left for the next run to look at, idle or not.
        self.assertEqual(outcome, prune.Outcome(False, None))
        self.assertEqual(self.lines(), (['k', 'b', 'after'], []))

    def test_rows_removed_in_place_meanwhile_are_not_brought_back_or_garbled(self):
        self.write([message('a', None, text=BIG), boundary('k'), message('b', 'k'), message('gone', 'b'), message('c', 'b')])
        copy_tail = prune.copy_tail
        calls = []

        def remove_in_place_then_copy(source, out, offset):
            if not calls:
                lines = self.path.read_bytes().splitlines(keepends=True)
                start = sum(len(line) for line in lines[:3])
                with open(self.path, 'r+b') as f:
                    f.truncate(start)
                    f.seek(start)
                    f.write(lines[4])
                with open(self.path, 'ab') as f:
                    f.write((json.dumps(message('next', 'c', text='n' * 300)) + '\n').encode())
            calls.append(offset)
            return copy_tail(source, out, offset)

        with mock.patch.object(prune, 'copy_tail', remove_in_place_then_copy):
            outcome = prune.prune(str(self.path))
        self.assertEqual(outcome.sizes, None)
        self.assertEqual(self.lines(), (['a', 'k', 'b', 'c', 'next'], []))

    def test_a_transcript_being_rewritten_in_place_is_never_replaced_by_a_shorter_copy(self):
        rows = [message('a', None, text=BIG), boundary('k')] + [message(f'm{n}', 'k', text='z' * 5000) for n in range(20)]
        self.write(rows)
        slimmed = prune.slimmed
        written = {}

        def slimmed_then_rewrite_in_place(rows_, drop, source):
            found = slimmed(rows_, drop, source)
            data = self.path.read_bytes()
            written['half'] = data[:len(data) // 2]
            with open(self.path, 'wb') as f:
                f.write(written['half'])
            return found

        with mock.patch.object(prune, 'slimmed', slimmed_then_rewrite_in_place):
            outcome = prune.prune(str(self.path))
        self.assertEqual(outcome.sizes, None)
        # The other writer goes on writing its own file; the prune left it alone.
        self.assertEqual(self.path.read_bytes(), written['half'])


class Shapes(Transcript):
    def test_a_row_nested_deeper_than_python_recurses_is_reported_and_the_next_transcript_still_pruned(self):
        nested = {'type': 'user', 'uuid': 'deep', 'parentUuid': None,
                  'toolUseResult': json.loads('[' * 2000 + ']' * 2000),
                  'message': {'role': 'user', 'content': [json.loads('[' * 2000 + ']' * 2000)]}}
        first = self.path.with_name('aaaa.jsonl')
        second = self.path.with_name('bbbb.jsonl')
        self.write([message('a', None, text=BIG), boundary('k'), nested], first)
        self.write([message('a', None, text=BIG), boundary('k'), message('b', 'k')], second)
        result = self.cli('--all')
        self.assertEqual(result.returncode, 1)
        self.assertIn('aaaa.jsonl', result.stderr)
        self.assertEqual(self.kinds(second), ['k', 'b'])
        # Told once: unchanged, the next run passes it by.
        self.assertEqual(self.cli('--all').returncode, 0)

    def test_a_kept_request_keeps_the_request_it_builds_on(self):
        x = {**request(0, ['hx1']), 'querySource': 'b', 'id': 'X'}
        a1 = {**request(2, ['h3']), 'querySource': 'a', 'id': 'A1', 'base': 'X'}
        a2 = {**request(0, ['h4']), 'querySource': 'a', 'id': 'A2'}
        b2 = {**request(0, ['h5']), 'querySource': 'b', 'id': 'B2'}
        self.write([message('m', None, text=BIG), blob('hx1'), x, boundary('k'), blob('h3'), a1, blob('h4'), a2, blob('h5'), b2])
        prune.prune(str(self.path))
        rows = self.rows()
        self.assertEqual([row.get('id') for row in rows if row['type'] == 'api-request'], ['X', 'A1', 'A2', 'B2'])
        self.assertIn('hx1', [row.get('hash') for row in rows if row['type'] == 'api-request-blob'])


if __name__ == '__main__':
    unittest.main()
