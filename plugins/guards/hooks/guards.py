#!/usr/bin/env python3
"""Run the guard hooks in one process, reading the hook input once.

Modes, picked by the first argument:
  bash   PreToolUse on Bash: discard_guard, pipe_guard, tmp_guard, message_guard and
         merge_guard, in that order.
  files  PreToolUse on Write, Edit, MultiEdit and NotebookEdit: tmp_guard alone.

Each guard decides the way it did when it ran as a hook of its own. When one guard
objects, the answer is its decision and its reason, word for word. When several
object to the same call, the decision is "deny" if any of them denies and "ask"
otherwise, and the reason holds every objecting guard's reason in the order above,
separated by a blank line. A call no guard objects to prints nothing.

merge_guard asks GitHub only about a `gh pr merge` it finds in the command, so for
any other command no check waits on the network. It runs last and must finish
MERGE_DEADLINE seconds after the hook started, which leaves time under the hook's
40 second timeout to print the other guards' answers. A merge still unchecked at
the deadline is denied. message_guard runs git, with a 5 second limit, only for a
`git commit` whose message it can read.

A guard that raises an error counts as no objection, as it did when each guard ran
alone and Claude Code ran the command after a crashed hook. The error goes to
stderr, and when no other guard objects the hook exits 1, so Claude Code still
reports a hook error. Input that is not a JSON object is that case for all of them.
"""
import importlib
import json
import os
import signal
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Each guard is imported on its own when it runs, so one that fails to import
# stops only itself, as when every guard was a script of its own.
MODES = {
    "bash": ("discard_guard", "pipe_guard", "tmp_guard", "message_guard", "merge_guard"),
    "files": ("tmp_guard",),
}
# Seconds from the start of the hook. hooks/hooks.json gives the Bash hook 40.
MERGE_DEADLINE = 35
OUT_OF_TIME = (
    f"The check of which branch this merge lands on did not finish within "
    f"{MERGE_DEADLINE} seconds, so the command was stopped. Check the base with "
    f"`gh pr view --json baseRefName`, then run the merge again with MERGE_BASE_OK=1 "
    f"in front if the base is the one you mean."
)


class OutOfTime(BaseException):
    """Raised into merge_guard at the deadline. A BaseException, so none of the
    guard's own `except` clauses catches it."""


def _stop(signum, frame):
    raise OutOfTime()


def _check_by(guard, payload, seconds_left):
    """The guard's reason, else None. merge_guard runs under an alarm that stops it
    after `seconds_left`."""
    if guard.__name__ != "merge_guard" or not hasattr(signal, "setitimer"):
        return guard.check(payload)
    previous = signal.signal(signal.SIGALRM, _stop)
    signal.setitimer(signal.ITIMER_REAL, max(seconds_left, 0.001))
    try:
        return guard.check(payload)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def evaluate(mode, payload, started=None, deadline=MERGE_DEADLINE):
    """(objections, errors): (decision, reason) for each guard of `mode` that objects,
    in order, and the error text of each guard that raised."""
    started = time.monotonic() if started is None else started
    objections, errors = [], []
    for name in MODES[mode]:
        try:
            guard = importlib.import_module(name)
            why = _check_by(guard, payload, deadline - (time.monotonic() - started))
        except OutOfTime:
            why = OUT_OF_TIME
        except Exception:
            errors.append(f"{name}: {traceback.format_exc()}")
            continue
        if why is not None:
            objections.append((guard.DECISION, why))
    return objections, errors


def combined(objections):
    """The hook's answer for these objections, or None when there are none."""
    if not objections:
        return None
    decisions = {decision for decision, _ in objections}
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny" if "deny" in decisions else "ask",
        "permissionDecisionReason": "\n\n".join(why for _, why in objections),
    }}


def main(argv):
    started = time.monotonic()
    mode = argv[1] if len(argv) > 1 else ""
    if mode not in MODES:
        # A wiring mistake in hooks.json. Exit 2 blocks the call and shows this.
        sys.stderr.write(f"guards.py: unknown mode {mode!r}, expected one of {sorted(MODES)}\n")
        return 2
    try:
        payload = json.load(sys.stdin)
    except ValueError as error:
        sys.stderr.write(f"guards.py: the hook input is not JSON ({error})\n")
        return 1
    objections, errors = evaluate(mode, payload, started)
    for error in errors:
        sys.stderr.write(f"guards.py: {error}")
    answer = combined(objections)
    if answer is not None:
        print(json.dumps(answer))
        return 0
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
