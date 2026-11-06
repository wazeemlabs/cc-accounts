"""What the cca-stream tests share: the script, loaded as a module, and the
stream-json lines they send."""
import importlib.machinery
import importlib.util
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'libexec' / 'cca-stream'
ID = '0f4a6c1e-1111-4222-8333-944455556666'
WAIT = 10

_loader = importlib.machinery.SourceFileLoader('cca_stream', str(SCRIPT))
_spec = importlib.util.spec_from_loader('cca_stream', _loader)
stream = importlib.util.module_from_spec(_spec)
_loader.exec_module(stream)


def user(text, uuid=None):
    message = {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]},
               'parent_tool_use_id': None, 'session_id': ID}
    return message if uuid is None else {**message, 'uuid': uuid}


def without_uuid(message):
    return {key: value for key, value in message.items() if key != 'uuid'}


def line(value):
    return (json.dumps(value) + '\n').encode()


def control(request_id, subtype, **fields):
    return {'type': 'control_request', 'request_id': request_id, 'request': {'subtype': subtype, **fields}}
