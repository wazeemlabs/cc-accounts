"""How far into each conversation's transcript prune.py has looked for a
compaction, for `--since`: a session asks at every turn's end, and only a
compact boundary written since the last look is worth reading the transcript
whole for. Kept in a file of its own, `{path: [inode, offset]}`, small enough
to rewrite at every turn's end."""
import json
import os
import sys

from transcript_rows import row_of

# In every compact boundary row, however its JSON is spaced: only a row
# holding it is parsed.
WORD = b'compact_boundary'


def read(path):
    try:
        with open(path) as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {}
    except ValueError as error:
        print(f'cc-accounts: {path} is not a tails file ({error}); every transcript is looked at again', file=sys.stderr)
        return {}
    return value if isinstance(value, dict) else {}


def write(path, tails):
    temp = f'{path}.{os.getpid()}.tmp'
    try:
        with open(temp, 'w') as handle:
            json.dump(tails, handle, sort_keys=True)
            handle.write('\n')
        os.replace(temp, path)
    except BaseException:
        if os.path.exists(temp):
            os.remove(temp)
        raise


def compacted(path, tail):
    """Whether the transcript at `path` may have been compacted since `tail`
    saw it, and its tail now: the file, and the end of its last whole row.

    It may have when a main-loop compact boundary was written after the tail,
    and when the tail does not tell: none was kept, or the file is another
    (a prune's rewrite and Claude Code's own compaction each put a new file at
    the path) or shorter than the tail (Claude Code removed a row in place)."""
    with open(path, 'rb') as source:
        status = os.fstat(source.fileno())
        known = (isinstance(tail, list) and len(tail) == 2 and tail[0] == status.st_ino
                 and isinstance(tail[1], int) and 0 <= tail[1] <= status.st_size)
        offset = tail[1] if known else 0
        found = not known
        source.seek(offset)
        while offset < status.st_size:
            line = source.readline(status.st_size - offset)
            if not line.endswith(b'\n'):
                # A row still being written: the next look reads it whole.
                break
            found = found or (WORD in line and row_of(offset, line).boundary is not None)
            offset += len(line)
        return found, [status.st_ino, offset]
