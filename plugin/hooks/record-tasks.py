#!/usr/bin/env python3
"""Stop hook: saves the background work a session still runs when a turn ends.

Claude Code passes the hook its input on stdin, with `session_id` and
`background_tasks` (subagents, shells, monitors and workflows in flight).
This writes {"tasks": [...]} to <CCA_ROOT>/background/<session id>, where the
plugin's module reads it when the turn completes, to decide whether a pending
switch can end the process yet. The session's scheduled wakeups are not
taken from here: `session_crons` clips their prompts, so the module asks
CronList when a switch needs them. A session that cca does not manage (no
accounts.tsv) writes nothing.
"""
import json
import os
import re
import sys
import tempfile

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
KEPT = ('id', 'type', 'status', 'description')


def root():
    return os.environ.get('CCA_ROOT') or os.path.join(os.path.expanduser('~'), '.claude-shared', 'accounts')


def tasks_of(hook_input):
    """The input's tasks, each cut to what the plugin reads; ValueError when it is not the shape Claude Code sends."""
    if not isinstance(hook_input, dict):
        raise ValueError('the hook input is not a JSON object')
    session_id = hook_input.get('session_id')
    if not isinstance(session_id, str) or not UUID_RE.match(session_id):
        raise ValueError(f'session_id {session_id!r} is not a conversation id')
    if 'background_tasks' not in hook_input:
        raise ValueError('this Claude Code does not list background tasks at the end of a turn, '
                         'so /account cannot wait for them')
    tasks = hook_input['background_tasks']
    if not isinstance(tasks, list) or not all(isinstance(t, dict) and isinstance(t.get('id'), str) for t in tasks):
        raise ValueError('background_tasks is not a list of tasks with ids')
    return session_id, [{k: t[k] for k in KEPT if isinstance(t.get(k), str)} for t in tasks]


def write_atomic(path, text):
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix='.tmp-')
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def main():
    state = root()
    if not os.path.isfile(os.path.join(state, 'accounts.tsv')):
        return 0
    try:
        session_id, tasks = tasks_of(json.load(sys.stdin))
    except ValueError as error:
        # Exit 1: Claude Code shows a Stop hook error and goes on.
        print(f'cc-accounts: {error}', file=sys.stderr)
        return 1
    write_atomic(os.path.join(state, 'background', session_id), json.dumps({'tasks': tasks}) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
