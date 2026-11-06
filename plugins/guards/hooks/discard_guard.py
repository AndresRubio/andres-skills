#!/usr/bin/env python3
"""Ask before a git command that throws away uncommitted work.

PreToolUse on Bash. A command that discards working-tree edits or deletes untracked
files gets permissionDecision "ask", so a person sees it before it runs:

  git checkout -- <path>, git checkout <ref> -- <path>, git checkout .,
  git checkout -f, git restore <path> (unless only --staged), git reset --hard,
  git clean -f, git switch -f / --discard-changes

`git checkout <path>` with no `--` reads the same as a branch switch, so it passes.
Anything else prints nothing and goes through the usual permission flow.
"""
import json
import os
import re
import shlex
import sys

# Shell separators between commands; quoting is ignored, so a separator inside a
# quoted string splits it too, which only ever adds a prompt.
SEPARATORS = re.compile(r"&&|\|\||[;|&\n()]")
# git options before the subcommand that take a value as the next word.
GIT_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
# What the hook answers when check() gives a reason.
DECISION = "ask"


def _words(segment):
    try:
        return shlex.split(segment)
    except ValueError:
        return segment.split()


def _short_flags(args):
    """Letters of bundled short options, such as "fdx" from "-fdx"."""
    return "".join(a[1:] for a in args if a.startswith("-") and not a.startswith("--"))


def _discards(sub, args):
    """What `git <sub> <args>` throws away, or None if it keeps the working tree."""
    if sub == "checkout":
        if "--" in args or "." in args:
            return "uncommitted edits to the files named"
        if "--force" in args or "f" in _short_flags(args):
            return "uncommitted edits, to switch branch"
    elif sub == "restore":
        staged = "--staged" in args or "S" in _short_flags(args)
        worktree = "--worktree" in args or "W" in _short_flags(args)
        if worktree or not staged:
            return "uncommitted edits to the files named"
    elif sub == "reset":
        if "--hard" in args:
            return "every uncommitted edit"
    elif sub == "clean":
        dry_run = "--dry-run" in args or "n" in _short_flags(args)
        if not dry_run and ("--force" in args or "f" in _short_flags(args)):
            return "untracked files"
    elif sub == "switch":
        if {"-f", "--force", "--discard-changes"} & set(args):
            return "uncommitted edits, to switch branch"
    return None


def discarded(command):
    """What `command` would throw away, or None."""
    for segment in SEPARATORS.split(command):
        words = _words(segment)
        for i, word in enumerate(words):
            if os.path.basename(word) != "git":
                continue
            j = i + 1
            while j < len(words) and words[j].startswith("-"):
                j += 2 if words[j] in GIT_OPTIONS_WITH_VALUE else 1
            if j < len(words):
                what = _discards(words[j], words[j + 1 :])
                if what:
                    return what
    return None


def check(payload):
    """Why a person should see this tool call before it runs, else None."""
    command = (payload.get("tool_input") or {}).get("command") or ""
    what = discarded(command)
    if what is None:
        return None
    return (
        f"This git command throws away {what}, and nothing can bring them back. "
        "Approve only if that is intended. To undo a temporary probe, remove it "
        "with an edit."
    )


def main():
    why = check(json.load(sys.stdin))
    if why is None:
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": DECISION,
        "permissionDecisionReason": why,
    }}))


if __name__ == "__main__":
    main()
