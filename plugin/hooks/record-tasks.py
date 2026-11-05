#!/usr/bin/env python3
"""Stop hook: saves the background work a session still runs when a turn ends.

Claude Code passes the hook its input on stdin, with `session_id`,
`background_tasks` (subagents, shells, monitors and workflows in flight) and
`session_crons` (the CronCreate, ScheduleWakeup and /loop wakeups the session
holds). This writes {"tasks": [...], "crons": [...]} to
<CCA_ROOT>/background/<session id>, where the plugin's module reads it when
the turn completes: the tasks decide whether a pending switch can end the
process yet, and the wakeups, which ending it drops, are handed to the
reopened conversation to set again. A session that cca does not manage (no
accounts.tsv) writes nothing.
"""
import json
import os
import re
import sys
import tempfile

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
KEPT = ('id', 'type', 'status', 'description')
CRON_KEPT = ('id', 'schedule', 'recurring', 'prompt')


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
    crons = hook_input.get('session_crons', [])
    if not isinstance(crons, list) or not all(isinstance(c, dict) and isinstance(c.get('schedule'), str) for c in crons):
        raise ValueError('session_crons is not a list of scheduled wakeups')
    return (session_id, [{k: t[k] for k in KEPT if isinstance(t.get(k), str)} for t in tasks],
            [{k: c[k] for k in CRON_KEPT if k in c} for c in crons])


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
        session_id, tasks, crons = tasks_of(json.load(sys.stdin))
    except ValueError as error:
        # Exit 1: Claude Code shows a Stop hook error and goes on.
        print(f'cc-accounts: {error}', file=sys.stderr)
        return 1
    write_atomic(os.path.join(state, 'background', session_id), json.dumps({'tasks': tasks, 'crons': crons}) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
