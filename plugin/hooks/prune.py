#!/usr/bin/env python3
"""Prunes Claude Code transcripts to their last compaction, for cc-accounts.

A compacted conversation goes on from its last compact boundary: Claude Code
resumes it from there, with the messages the compaction preserved. The rows
before it stay in the file, and screenshots pile up in it and in subagents'
transcripts (2026-11-15: 30 GB over 810 transcripts, one of 2.3 GB, a
subagent's 495 MB nearly all images), which an editor or the desktop app
reads whole when it opens the conversation. So this:

  - drops the conversation rows before the last boundary that the boundary
    does not preserve, or that a later row or a fork of the conversation
    still names;
  - drops the request log (api-request, its blobs and shapes), a record
    Claude Code writes so a resumed request can be sent byte for byte while
    the prompt cache holds it, and never reads to rebuild the conversation:
    all of it once the transcript has been idle for IDLE_SECONDS, the
    cache's life, judged by its newest row's own time (a rewrite changes the
    file's), and before that the rows no request since the last boundary
    builds on;
  - replaces every image but the newest KEEP_IMAGES of a transcript with a
    line saying it was removed, in the conversation's rows, never in the
    request log, whose blobs are named by their hash; a row's toolUseResult,
    the tool's own copy of what it returned, loses its images with the
    row's last one (a Read result's base64 emptied, as Claude Code's own
    slim mode leaves it), and does not count among the newest;
  - keeps every other row (titles, file history) as it was.

  prune.py --projects DIR --lock FILE --state FILE --session ID
  prune.py --projects DIR --lock FILE --state FILE --all [--min-bytes N]

--session prunes that conversation's transcripts (its own and its
subagents'); --all every transcript of at least --min-bytes (by default
MIN_IDLE_SAVING, below which none can save enough) that changed since the
state file last saw it, idle, under these rules. One line is printed per transcript shrunk.
A transcript is replaced atomically, and rows Claude Code appends meanwhile
are carried over, so a live session's file can be pruned. One prune runs at
a time on the machine, under the lock.
"""
import argparse
import fcntl
import glob
import json
import os
import signal
import sys
import time
from collections import namedtuple
from datetime import datetime

# The rows of the conversation itself.
CONVERSATION = frozenset({'user', 'assistant', 'attachment', 'system', 'progress'})
# The newest images a transcript keeps whole, so a resumed session or agent
# still sees what it looked at last.
KEEP_IMAGES = 5
REMOVED = '[image removed by cc-accounts to save space]'
# Below this saving a transcript is left as it is, so a live one is not
# rewritten for a few rows; an idle one is rewritten once, and the state
# then passes it by, so a smaller saving is worth it.
MIN_SAVING = 1_000_000
MIN_IDLE_SAVING = 64_000
# The prompt cache's life: a transcript idle this long has no request left
# that its log could replay into a cache hit.
IDLE_SECONDS = 3600
# The rules the state file was written under: a state of other rules looks
# at every transcript again.
STATE_VERSION = 4
CHUNK = 1 << 20


class Row:
    __slots__ = ('offset', 'length', 'kind', 'uuid', 'parent', 'boundary', 'images', 'copies',
                 'source', 'keep', 'names', 'name', 'fork', 'at')

    def __init__(self, offset, length):
        self.offset = offset
        self.length = length
        self.kind = None
        self.uuid = None
        self.parent = None
        # The compaction's metadata, on a main-loop compact boundary only.
        self.boundary = None
        # Base64 images in a conversation row, and whether its toolUseResult
        # holds a copy of one.
        self.images = 0
        self.copies = False
        # An api-request: its query source, how many messages of the request
        # before it it starts with, and the blob and shape hashes it names.
        self.source = None
        self.keep = 0
        self.names = ()
        # An api-request-blob's or api-request-shape's hash.
        self.name = None
        # A fork-context-ref's parent: (session id, the message it forked from).
        self.fork = None
        # When Claude Code wrote the row, in seconds, where it says.
        self.at = None


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def is_image(value):
    return (isinstance(value, dict) and value.get('type') == 'image' and isinstance(value.get('source'), dict)
            and value['source'].get('type') == 'base64')


def count_images(value):
    if is_image(value):
        return 1
    if isinstance(value, dict):
        return sum(count_images(item) for item in value.values())
    if isinstance(value, list):
        return sum(count_images(item) for item in value)
    return 0


def is_read_copy(value):
    """A Read tool's toolUseResult for an image, still holding its data."""
    return (isinstance(value, dict) and value.get('type') == 'image' and isinstance(value.get('file'), dict)
            and isinstance(value['file'].get('base64'), str) and value['file']['base64'] != '')


def without_images(value, budget):
    """`value` with its first `budget[0]` images replaced, in order."""
    if budget[0] > 0 and is_image(value):
        budget[0] -= 1
        return {'type': 'text', 'text': REMOVED}
    if isinstance(value, dict):
        return {key: without_images(item, budget) for key, item in value.items()}
    if isinstance(value, list):
        return [without_images(item, budget) for item in value]
    return value


def seconds(stamp):
    """An ISO 8601 time, as Claude Code writes `timestamp`, in seconds; None
    when it is not one."""
    if stamp is None:
        return None
    try:
        return datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def row_of(offset, line):
    row = Row(offset, len(line))
    try:
        data = json.loads(line)
    except ValueError:
        # Not a row Claude Code reads as one: kept as it is.
        return row
    if not isinstance(data, dict):
        return row
    text = lambda key: data.get(key) if isinstance(data.get(key), str) else None
    row.kind = data.get('type')
    row.at = seconds(text('timestamp'))
    row.uuid = text('uuid')
    row.parent = text('parentUuid')
    if row.kind == 'system' and data.get('subtype') == 'compact_boundary' and not data.get('isSidechain'):
        metadata = data.get('compactMetadata')
        row.boundary = metadata if isinstance(metadata, dict) else {}
    if row.kind in CONVERSATION:
        copy = data.get('toolUseResult')
        row.images = count_images({key: item for key, item in data.items() if key != 'toolUseResult'})
        row.copies = is_read_copy(copy) or count_images(copy) > 0
    elif row.kind == 'api-request':
        row.source = text('querySource')
        row.keep = data.get('keep') if isinstance(data.get('keep'), int) else 0
        tail = data.get('tail') if isinstance(data.get('tail'), list) else []
        row.names = frozenset([name for name in tail if isinstance(name, str)] + ([text('shapeHash')] if text('shapeHash') else []))
    elif row.kind == 'api-request-blob':
        row.name = text('hash')
    elif row.kind == 'api-request-shape':
        row.name = text('shapeHash')
    elif row.kind == 'fork-context-ref' and text('parentSessionId') and text('parentLastUuid'):
        row.fork = (text('parentSessionId'), text('parentLastUuid'))
    return row


def scan(source, size):
    """The rows in the first `size` bytes, up to the last whole line."""
    rows = []
    offset = 0
    source.seek(0)
    while offset < size:
        line = source.readline(size - offset)
        if not line.endswith(b'\n'):
            # A row still being written: it is carried over with the tail.
            break
        rows.append(row_of(offset, line))
        offset += len(line)
    return rows, offset


def chain_start(rows, requests):
    """Where the request log's last chains start: walking back from the last
    request, in file order and in each query source's own order, while a
    request starts with messages of the one before it."""
    start = len(rows)
    for group in [requests] + [[i for i in requests if rows[i].source == s] for s in {rows[i].source for i in requests}]:
        at = len(group) - 1
        while at > 0 and rows[group[at]].keep > 0:
            at -= 1
        if group:
            start = min(start, group[at])
    return start


REQUEST_LOG = frozenset({'api-request', 'api-request-blob', 'api-request-shape'})


def dropped(rows, idle=False, forked=frozenset()):
    """The indexes of the rows to drop. The conversation's before the last
    compact boundary, but for what the boundary preserved and the rows a row
    after it names as its parent, or a fork names as the message it forked
    from, with their parents. The request log's: all of it when `idle`, else
    the rows before the boundary that no request since builds on."""
    last = None
    for index, row in enumerate(rows):
        if row.boundary is not None:
            last = index
    drop = set()
    if last is not None:
        at = {row.uuid: index for index, row in enumerate(rows) if row.uuid is not None}
        preserved = {text for text in strings(rows[last].boundary) if text in at}
        drop = {
            index for index, row in enumerate(rows[:last])
            if row.kind in CONVERSATION and row.uuid is not None and row.uuid not in preserved
        }

        def keep(uuid):
            while uuid in at and at[uuid] in drop:
                index = at[uuid]
                drop.discard(index)
                uuid = rows[index].parent

        # The boundary's own parent is empty: it starts the chain.
        for row in rows[last + 1:]:
            keep(row.parent)
        for uuid in forked:
            keep(uuid)
    if idle:
        drop.update(index for index, row in enumerate(rows) if row.kind in REQUEST_LOG)
    elif last is not None:
        requests = [index for index, row in enumerate(rows) if row.kind == 'api-request']
        start = chain_start(rows, requests)
        named = set().union(*(rows[index].names for index in requests if index >= start or index > last))
        for index, row in enumerate(rows[:last]):
            if (row.kind == 'api-request' and index < start) or (
                    row.kind in ('api-request-blob', 'api-request-shape') and row.name not in named):
                drop.add(index)
    return drop


def forks_of(path):
    """The messages of the conversation at `path` that its forks started
    from: a fork's fork-context-ref, in the conversation's own transcript or
    its subagents', names its parent session and message."""
    folder, name = os.path.split(path)
    session = name[:-len('.jsonl')]
    found = set()
    for transcript in [path] + glob.glob(f'{glob.escape(os.path.join(folder, session))}/subagents/*.jsonl'):
        try:
            with open(transcript, 'rb') as handle:
                for offset, line in enumerate(handle):
                    if b'"fork-context-ref"' in line:
                        row = row_of(offset, line)
                        if row.fork is not None and row.fork[0] == session:
                            found.add(row.fork[1])
        except FileNotFoundError:
            continue
    return frozenset(found)


def without_copy(copy):
    """A toolUseResult without its images."""
    if is_read_copy(copy):
        return {**copy, 'file': {**copy['file'], 'base64': ''}}
    return without_images(copy, [float('inf')])


def slimmed(rows, drop, source):
    """The kept conversation rows that carry an image older than the newest
    KEEP_IMAGES, or a toolUseResult copy of an image the row no longer
    shows, rewritten without those: index to the new line."""
    kept = [index for index, row in enumerate(rows) if (row.images or row.copies) and index not in drop]
    older = sum(rows[index].images for index in kept) - KEEP_IMAGES
    lines = {}
    for index in kept:
        row = rows[index]
        replaced = min(max(older, 0), row.images)
        older -= replaced
        if replaced == 0 and not (row.copies and row.images == 0):
            continue
        source.seek(row.offset)
        value = json.loads(source.read(row.length))
        # The budget is the message's: the copy, wherever the row puts it, is not counted.
        budget = [replaced]
        value = {key: item if key == 'toolUseResult' else without_images(item, budget) for key, item in value.items()}
        if row.copies and replaced == row.images:
            # The message shows none of its images now: the copy goes too.
            value['toolUseResult'] = without_copy(value['toolUseResult'])
        # Escaped to ASCII: a lone surrogate, which JSON allows, has no UTF-8 form.
        lines[index] = (json.dumps(value, separators=(',', ':')) + '\n').encode()
    return lines


def copy_tail(source, out, offset):
    source.seek(offset)
    while True:
        chunk = source.read(CHUNK)
        if not chunk:
            return offset
        out.write(chunk)
        offset += len(chunk)


# What a prune found: whether the transcript was idle, and its (bytes
# before, bytes after), or None when there was not enough to drop.
Outcome = namedtuple('Outcome', 'idle sizes')


def prune(path, now=None):
    """Shrinks the transcript at `path`, as an Outcome. `now`, the time in
    seconds, says whether it has been idle since its newest row, or since
    the file last changed when no row says when it was written."""
    forked = forks_of(path)
    with open(path, 'rb') as source:
        status = os.fstat(source.fileno())
        size = status.st_size
        rows, whole = scan(source, size)
        written = max((row.at for row in rows if row.at is not None), default=status.st_mtime)
        idle = (time.time() if now is None else now) - written >= IDLE_SECONDS
        drop = dropped(rows, idle, forked)
        lines = slimmed(rows, drop, source)
        saving = sum(rows[index].length for index in drop) + sum(rows[index].length - len(line) for index, line in lines.items())
        if saving < (MIN_IDLE_SAVING if idle else MIN_SAVING):
            return Outcome(idle, None)
        temp = f'{path}.cca-prune-{os.getpid()}.tmp'
        try:
            with open(temp, 'wb') as out:
                source.seek(0)
                for index, row in enumerate(rows):
                    line = source.read(row.length)
                    if index not in drop:
                        out.write(lines.get(index, line))
                # Rows appended since the scan, and a row it found half written.
                copied = copy_tail(source, out, whole)
                out.flush()
                os.fsync(out.fileno())
            os.chmod(temp, os.stat(path).st_mode & 0o7777)
            os.replace(temp, path)
        except BaseException:
            if os.path.exists(temp):
                os.remove(temp)
            raise
        # Claude Code opens the file for each row it appends: one that opened
        # it before the replace wrote into the old file, still open here.
        with open(path, 'ab') as out:
            copy_tail(source, out, copied)
    return Outcome(idle, (size, os.stat(path).st_size))


def transcripts(projects, session):
    """The transcripts under `projects`, conversations' and subagents', or
    the session's alone."""
    name = '*' if session is None else glob.escape(session)
    root = glob.escape(projects)
    found = glob.glob(f'{root}/*/{name}.jsonl') + glob.glob(f'{root}/*/{name}/subagents/*.jsonl')
    return sorted(path for path in found if os.path.isfile(path))


def stamp(path):
    status = os.stat(path)
    return [status.st_size, status.st_mtime_ns]


def read_state(path):
    """Each transcript's size and mtime when last looked at under these
    rules; nothing for a state of other rules."""
    try:
        with open(path) as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {}
    except ValueError as error:
        print(f'cc-accounts: {path} is not a prune state file ({error}); every transcript is looked at again',
              file=sys.stderr)
        return {}
    if not isinstance(value, dict) or value.get('version') != STATE_VERSION or not isinstance(value.get('files'), dict):
        return {}
    return value['files']


def write_state(path, files):
    temp = f'{path}.{os.getpid()}.tmp'
    try:
        with open(temp, 'w') as handle:
            json.dump({'version': STATE_VERSION, 'files': files}, handle, sort_keys=True)
            handle.write('\n')
        os.replace(temp, path)
    except BaseException:
        if os.path.exists(temp):
            os.remove(temp)
        raise


def megabytes(count):
    return f'{count / 1e6:.0f} MB'


def main(argv=None):
    parser = argparse.ArgumentParser(prog='prune.py')
    parser.add_argument('--projects', required=True)
    parser.add_argument('--lock', required=True)
    parser.add_argument('--state', required=True)
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument('--session')
    which.add_argument('--all', action='store_true')
    parser.add_argument('--min-bytes', type=int, default=MIN_IDLE_SAVING)
    args = parser.parse_args(argv)
    # A hot reload of the plugin ends its children: the temporary file goes
    # and the transcript stays as it was.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    if not os.path.isdir(args.projects):
        return 0
    with open(args.lock, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_state(args.state)
        failed = False
        seen = {}
        for path in transcripts(args.projects, args.session):
            try:
                now = stamp(path)
                if args.all and (now[0] < args.min_bytes or state.get(path) == now):
                    seen[path] = state.get(path, now)
                    continue
                result = prune(path)
                if result.sizes is not None:
                    print(f'{path}: {megabytes(result.sizes[0])} -> {megabytes(result.sizes[1])}', flush=True)
                # One still active is looked at again: once idle, its request log goes.
                if result.idle:
                    seen[path] = stamp(path)
            except FileNotFoundError:
                # Deleted since the listing.
                continue
            except (OSError, ValueError) as error:
                failed = True
                print(f'cc-accounts: could not prune {path} ({error})', file=sys.stderr, flush=True)
        state = seen if args.all else {**state, **seen}
        write_state(args.state, state)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
