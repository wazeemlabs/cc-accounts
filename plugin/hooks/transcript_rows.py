"""The rows of a Claude Code transcript as prune.py reads them: each row's
kind, links and the parts the prune drops or slims, from one pass over the
file, and the walks that count and replace images. Pure: prune.py does the
reading of files and the rewriting."""
import json
from datetime import datetime

# The rows of the conversation itself.
CONVERSATION = frozenset({'user', 'assistant', 'attachment', 'system', 'progress'})
REMOVED = '[image removed by cc-accounts to save space]'


class Row:
    __slots__ = ('offset', 'length', 'kind', 'uuid', 'parent', 'boundary', 'images', 'copies',
                 'source', 'keep', 'names', 'name', 'fork', 'at', 'id', 'base')

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
        # before it it starts with, the blob and shape hashes it names, its
        # id, and the id of the request it starts from (`base`).
        self.source = None
        self.keep = 0
        self.names = ()
        self.id = None
        self.base = None
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
        row.id = text('id')
        row.base = text('base')
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


def without_copy(copy):
    """A toolUseResult without its images."""
    if is_read_copy(copy):
        return {**copy, 'file': {**copy['file'], 'base64': ''}}
    return without_images(copy, [float('inf')])
