"""Tests for plugin/hooks/prune.py, which prunes transcripts to their last
compaction and newest images.
Run: python3 -m unittest discover -s tests"""
import fcntl
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'plugin' / 'hooks' / 'prune.py'
spec = importlib.util.spec_from_file_location('prune', SCRIPT)
prune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune)

SESSION = '0f4a6c1e-1111-4222-8333-944455556666'
# A conversation row this long makes a drop worth a rewrite on its own.
BIG = 'x' * (prune.MIN_SAVING + 1)


def message(uuid, parent, kind='user', text='hi', side=False):
    return {'type': kind, 'uuid': uuid, 'parentUuid': parent, 'isSidechain': side,
            'message': {'role': kind, 'content': [{'type': 'text', 'text': text}]}}


def boundary(uuid, preserved=(), side=False):
    return {'type': 'system', 'subtype': 'compact_boundary', 'uuid': uuid, 'parentUuid': None,
            'logicalParentUuid': 'old', 'isSidechain': side,
            'compactMetadata': {'trigger': 'auto', 'preservedSegment': {'headUuid': preserved[0]} if preserved else {},
                                'preservedMessages': {'uuids': list(preserved)}}}


def image(data):
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': data}}


def screenshot(uuid, parent, data):
    return {'type': 'user', 'uuid': uuid, 'parentUuid': parent,
            'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': f't-{uuid}', 'content': [image(data)]}]}}


def request(keep, tail, shape='s1'):
    return {'type': 'api-request', 'querySource': 'sdk', 'keep': keep, 'tail': tail, 'shapeHash': shape}


def blob(name, text='content'):
    return {'type': 'api-request-blob', 'hash': name, 'message': {'role': 'user', 'content': text}}


class Transcript(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = pathlib.Path(self.tmp.name) / 'projects'
        self.folder = self.projects / '-work'
        self.folder.mkdir(parents=True)
        self.path = self.folder / f'{SESSION}.jsonl'

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rows, path=None):
        path = path or self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        os.chmod(path, 0o600)
        return path

    def rows(self, path=None):
        return [json.loads(line) for line in (path or self.path).read_text().splitlines()]

    def kinds(self, path=None):
        return [row.get('uuid') or row.get('hash') or row['type'] for row in self.rows(path)]

    def cli(self, *args):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), '--projects', str(self.projects),
                               '--lock', str(self.projects.parent / 'prune.lock'),
                               '--state', str(self.projects.parent / 'state.json'), *args],
                              capture_output=True, text=True, check=False)


class Compaction(Transcript):
    def test_drops_the_conversation_before_the_last_compaction_and_keeps_every_other_row(self):
        self.write([
            {'type': 'custom-title', 'customTitle': 'Studio'},
            message('a', None, text=BIG), message('b', 'a', 'assistant'),
            boundary('c1'), message('d', 'c1'),
            {'type': 'file-history-snapshot', 'messageId': 'd'},
            message('e', 'd', 'assistant'),
            boundary('c2', preserved=['e']), message('f', 'c2'),
            {'type': 'last-prompt', 'leafUuid': 'f'},
        ])
        before, after = prune.prune(str(self.path))
        self.assertEqual(self.kinds(), ['custom-title', 'file-history-snapshot', 'e', 'c2', 'f', 'last-prompt'])
        self.assertEqual(after, self.path.stat().st_size)
        self.assertGreater(before, after)

    def test_a_row_after_the_compaction_keeps_the_rows_it_names_as_its_parent(self):
        self.write([message('a', None), message('b', 'a'), message('c', 'b', text=BIG),
                    boundary('k'), message('late', 'b')])
        prune.prune(str(self.path))
        # b and its parents stay, back to the first row; c, which nothing names, goes.
        self.assertEqual(self.kinds(), ['a', 'b', 'k', 'late'])

    def test_a_subagents_own_compaction_inside_the_conversation_is_not_the_conversations(self):
        self.write([message('a', None, text=BIG), boundary('side', side=True), message('b', 'a')])
        self.assertIsNone(prune.prune(str(self.path)))
        self.assertEqual(self.kinds(), ['a', 'side', 'b'])

    def test_keeps_the_request_chain_the_conversation_builds_on_and_the_blobs_and_shapes_it_names(self):
        self.write([
            message('a', None, text=BIG),
            {'type': 'api-request-shape', 'shapeHash': 'old-shape'},
            {'type': 'api-request-shape', 'shapeHash': 's1'},
            blob('h-old', BIG), blob('h1'), blob('h2'),
            request(0, ['h-old'], 'old-shape'),
            request(0, ['h1']), request(1, ['h2']),
            boundary('k'),
            blob('h3'),
            # It starts with the two messages of the request before it, across the boundary.
            request(2, ['h3']),
        ])
        prune.prune(str(self.path))
        self.assertEqual(self.kinds(), ['api-request-shape', 'h1', 'h2', 'api-request', 'api-request', 'k', 'h3', 'api-request'])
        self.assertEqual([row.get('keep') for row in self.rows() if row['type'] == 'api-request'], [0, 1, 2])
        self.assertEqual([row['shapeHash'] for row in self.rows() if row['type'] == 'api-request-shape'], ['s1'])

    def test_a_request_log_reset_by_the_compaction_drops_everything_before_it(self):
        self.write([blob('h-old', BIG), request(0, ['h-old']), request(1, ['h-old']),
                    boundary('k'), blob('h1'), request(0, ['h1'])])
        prune.prune(str(self.path))
        self.assertEqual(self.kinds(), ['k', 'h1', 'api-request'])

    def test_a_request_chain_is_followed_within_its_query_source_too(self):
        side = {**request(0, ['h-side']), 'querySource': 'side'}
        self.write([message('a', None, text=BIG), blob('h1'), blob('h-side'), request(0, ['h1']), side,
                    boundary('k'), request(1, ['h2'])])
        prune.prune(str(self.path))
        # In file order the side query's reset would end the walk; in the sdk's own order it goes back to h1.
        self.assertIn('h1', self.kinds())

    def test_without_a_compaction_the_conversation_stays(self):
        self.write([message('a', None, text=BIG), message('b', 'a')])
        self.assertIsNone(prune.prune(str(self.path)))


class Images(Transcript):
    def test_keeps_the_newest_images_and_replaces_the_rest_with_a_note(self):
        data = 'A' * 600_000
        self.write([screenshot(f'i{n}', None, data) for n in range(8)])
        prune.prune(str(self.path))
        rows = self.rows()
        notes = [row['message']['content'][0]['content'][0] for row in rows]
        self.assertEqual(notes[:3], [{'type': 'text', 'text': prune.REMOVED}] * 3)
        self.assertTrue(all(prune.is_image(note) for note in notes[3:]))
        # The rest of each row is as it was.
        self.assertEqual([row['uuid'] for row in rows], [f'i{n}' for n in range(8)])
        self.assertEqual(rows[0]['message']['content'][0]['tool_use_id'], 't-i0')

    def test_a_row_with_several_images_loses_its_oldest_first(self):
        data = 'A' * 600_000
        row = {'type': 'user', 'uuid': 'many', 'message': {'role': 'user', 'content': [image(data) for _ in range(7)]}}
        self.write([row])
        prune.prune(str(self.path))
        content = self.rows()[0]['message']['content']
        self.assertEqual([prune.is_image(block) for block in content], [False, False] + [True] * 5)

    def test_never_touches_the_request_logs_blobs_which_are_named_by_their_hash(self):
        data = 'A' * 600_000
        held = {'type': 'api-request-blob', 'hash': 'h', 'message': {'role': 'user', 'content': [image(data)]}}
        self.write([held] + [screenshot(f'i{n}', None, data) for n in range(9)])
        prune.prune(str(self.path))
        self.assertEqual(self.rows()[0], held)

    def test_a_row_with_a_lone_surrogate_is_rewritten_as_valid_json(self):
        data = 'A' * 600_000
        odd = screenshot('odd', None, data)
        odd['message']['content'].append({'type': 'text', 'text': '\ud83d'})
        self.write([odd] + [screenshot(f'i{n}', None, data) for n in range(7)])
        self.assertIsNotNone(prune.prune(str(self.path)))
        self.assertEqual(self.rows()[0]['message']['content'][1]['text'], '\ud83d')
        self.assertEqual(self.rows()[0]['message']['content'][0]['content'][0]['text'], prune.REMOVED)

    def test_a_dropped_row_does_not_count_among_the_newest(self):
        data = 'A' * 600_000
        self.write([screenshot('old', None, data), message('a', 'old', text=BIG), boundary('k')]
                   + [screenshot(f'i{n}', 'k', data) for n in range(5)])
        prune.prune(str(self.path))
        self.assertEqual(self.kinds(), ['k'] + [f'i{n}' for n in range(5)])
        self.assertTrue(all(prune.is_image(row['message']['content'][0]['content'][0]) for row in self.rows()[1:]))


class Rewrite(Transcript):
    def test_a_saving_below_the_floor_leaves_the_file_as_it_was(self):
        self.write([message('a', None), boundary('k'), message('b', 'k')])
        before = (self.path.read_bytes(), self.path.stat().st_mtime_ns)
        self.assertIsNone(prune.prune(str(self.path)))
        self.assertEqual((self.path.read_bytes(), self.path.stat().st_mtime_ns), before)

    def test_keeps_the_files_mode(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        prune.prune(str(self.path))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_rows_appended_while_it_works_are_carried_over(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        scan = prune.scan

        def scan_then_append(source, size):
            found = scan(source, size)
            with open(self.path, 'a') as out:
                out.write(json.dumps(message('during', 'k')) + '\n')
            return found

        with mock.patch.object(prune, 'scan', scan_then_append):
            prune.prune(str(self.path))
        self.assertEqual(self.kinds(), ['k', 'during'])

    def test_a_row_half_written_at_the_scan_is_carried_over_whole(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        line = json.dumps(message('half', 'k'))
        with open(self.path, 'a') as out:
            out.write(line[:10])
        scan = prune.scan

        def scan_then_finish(source, size):
            found = scan(source, size)
            with open(self.path, 'a') as out:
                out.write(line[10:] + '\n')
            return found

        with mock.patch.object(prune, 'scan', scan_then_finish):
            prune.prune(str(self.path))
        self.assertEqual(self.kinds(), ['k', 'half'])

    def test_a_row_written_into_the_old_file_just_before_the_replace_is_carried_over(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        replace = os.replace

        def replace_under_a_writer(source, target):
            # A writer opened the transcript before the replace and writes after it.
            with open(target, 'a') as writer:
                replace(source, target)
                writer.write(json.dumps(message('late', 'k')) + '\n')

        with mock.patch.object(prune.os, 'replace', replace_under_a_writer):
            prune.prune(str(self.path))
        self.assertEqual(self.kinds(), ['k', 'late'])

    def test_a_prune_stopped_part_way_leaves_the_transcript_and_no_temporary_file(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        before = self.path.read_bytes()
        with mock.patch.object(prune.os, 'replace', side_effect=SystemExit(143)):
            with self.assertRaises(SystemExit):
                prune.prune(str(self.path))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), [self.path.name])


class Command(Transcript):
    def test_all_prunes_what_changed_lists_it_and_skips_it_next_time(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        small = self.write([message('a', None), boundary('k')], self.folder / 'small.jsonl')
        subagent = self.write([screenshot(f'i{n}', None, 'A' * 600_000) for n in range(9)],
                              self.folder / SESSION / 'subagents' / 'agent-a1.jsonl')
        done = self.cli('--all', '--min-bytes', '100')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(sorted(line.split(':')[0] for line in done.stdout.splitlines()), sorted([str(self.path), str(subagent)]))
        state = json.loads((self.projects.parent / 'state.json').read_text())
        self.assertEqual(set(state), {str(self.path), str(small), str(subagent)})
        again = self.cli('--all', '--min-bytes', '100')
        self.assertEqual((again.returncode, again.stdout), (0, ''))

    def test_all_leaves_a_transcript_below_the_size_it_looks_at(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        done = self.cli('--all', '--min-bytes', str(10 * len(BIG)))
        self.assertEqual((done.returncode, done.stdout), (0, ''))
        self.assertEqual(len(self.rows()), 2)

    def test_session_prunes_that_conversation_and_its_subagents_alone(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        other = self.write([message('a', None, text=BIG), boundary('k')], self.folder / 'other.jsonl')
        subagent = self.write([screenshot(f'i{n}', None, 'A' * 600_000) for n in range(9)],
                              self.folder / SESSION / 'subagents' / 'agent-a1.jsonl')
        done = self.cli('--session', SESSION)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(sorted(line.split(':')[0] for line in done.stdout.splitlines()), sorted([str(self.path), str(subagent)]))
        self.assertEqual(len(self.rows(other)), 2)

    def test_a_transcript_it_cannot_read_is_reported_and_the_rest_pruned(self):
        broken = self.write([message('a', None, text=BIG), boundary('k')], self.folder / 'broken.jsonl')
        # Removing the temporary folder needs only the folder's own mode.
        os.chmod(broken, 0)
        self.write([message('a', None, text=BIG), boundary('k')])
        done = self.cli('--all', '--min-bytes', '100')
        self.assertEqual(done.returncode, 1)
        self.assertIn(f'could not prune {broken}', done.stderr)
        self.assertEqual(self.kinds(), ['k'])

    def test_waits_while_another_prune_holds_the_lock(self):
        self.write([message('a', None, text=BIG), boundary('k')])
        with open(self.projects.parent / 'prune.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            child = subprocess.Popen([sys.executable, '-I', str(SCRIPT), '--projects', str(self.projects),
                                      '--lock', str(self.projects.parent / 'prune.lock'),
                                      '--state', str(self.projects.parent / 'state.json'), '--session', SESSION],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            with self.assertRaises(subprocess.TimeoutExpired):
                child.wait(timeout=1)
            self.assertEqual(len(self.rows()), 2)
        out, err = child.communicate(timeout=30)
        self.assertEqual(child.returncode, 0, err)
        self.assertEqual(self.kinds(), ['k'])

    def test_no_projects_folder_is_nothing_to_do(self):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--projects', str(self.projects / 'none'),
                               '--lock', str(self.projects.parent / 'prune.lock'),
                               '--state', str(self.projects.parent / 'state.json'), '--all'],
                              capture_output=True, text=True, check=False)
        self.assertEqual((done.returncode, done.stdout, done.stderr), (0, '', ''))


if __name__ == '__main__':
    unittest.main()
