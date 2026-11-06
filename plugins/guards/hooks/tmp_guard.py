#!/usr/bin/env python3
"""Deny a command or a file write that uses /tmp outside Claude Code's own folder there.

PreToolUse on Bash and on the file-writing tools. A session's temporary files belong in
its scratchpad (/private/tmp/claude-<uid>/<project>/<session>/scratchpad), and branch
work belongs in a worktree beside the repository. A file dropped straight into /tmp is
shared with every other session and nothing cleans it up.

A Bash command is denied when one of its words is a path under /tmp, /private/tmp or
/var/tmp that is not inside /tmp/claude-<uid>/. A word here is what the shell would
pass along: `"$out"/tmp`, `*/tmp/*` and `build/tmp` are other folders and pass. A path
glued to `=`, `:`, `,`, `@` or `{` counts (`--out=/tmp/x`, `PATH=$PATH:/tmp/bin`,
`-d @/tmp/body`). A quoted string that holds code or prose is searched for such a path
too, so `python3 -c` with /tmp in it is denied, and so is a message that only mentions
/tmp. The body of a heredoc is searched the same way.

A command that starts with TMP_OK=1 goes through, all of it: the user asked for the
path, or it is only mentioned. A Write, Edit, MultiEdit or NotebookEdit whose file is
there is denied the same way. Anything else prints nothing and goes through the usual
permission flow.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shell_words import simple_commands  # noqa: E402

# A word that is a path under /tmp.
ROOT = re.compile(r"^(?:/private)?(?:/var)?/tmp(?=/|$|})")
# The same path inside a longer text. What precedes it shows it starts a path: after a
# word character, `~`, `}`, `)`, `/`, `*`, `]`, `?`, `.` or `-` it is the tail of one.
INSIDE = re.compile(
    r"(?<![\w.~})/*\]?-])((?:/private)?(?:/var)?/tmp)(?![\w.-])(/[^\s'\"`;|&<>()]*)?"
)
# Claude Code's folder: every session's scratchpad and the bundled skills live in it.
OWN = re.compile(r"^/claude-\d+(?:/|$)")
# In front of the command, among the variables it sets.
ALLOWED = re.compile(r"^\s*(?:[A-Za-z_]\w*=\S*\s+)*TMP_OK=1(?:\s|$)")
# What the hook answers when check() gives a reason.
DECISION = "deny"


def own(rest):
    """Whether the part of a path after /tmp stays inside Claude Code's folder."""
    return bool(OWN.match(rest)) and ".." not in rest.split("/")


def as_path(word):
    """`word` if it is a path under /tmp outside Claude Code's folder, else None."""
    found = ROOT.match(word)
    if found and not own(word[found.end():]):
        return word
    return None


def inside(text):
    """The first such path inside a longer text, else None."""
    for found in INSIDE.finditer(text):
        if not own(found.group(2) or ""):
            return found.group(0)
    return None


def outside(command):
    """The first path in a Bash command that is under /tmp and outside Claude Code's
    folder, else None."""
    try:
        commands = simple_commands(command)
    except ValueError:
        # A quote that does not close: the text is searched as it stands.
        return inside(command)
    for words in commands:
        for word in words:
            if re.search(r"[\s'\"`]", word):
                # A quoted string of code or prose, as the shell would hand it over.
                path = inside(word)
            else:
                # `-C/tmp` and `-o/tmp/x` glue the path to a one-letter option, and
                # `${TMPDIR:-/tmp}` puts a sign between the colon and the path.
                parts = re.split(r"[=:,@{]", re.sub(r"^-[A-Za-z](?=/)", "", word))
                paths = [as_path(part.lstrip("-+?")) for part in parts]
                path = next((found for found in paths if found), None)
            if path is not None:
                return path
        for body in words.heredocs:
            # A script or a message fed to the command.
            path = inside(body)
            if path is not None:
                return path
    return None


def reason(payload):
    """Why this tool call is denied, else None."""
    tool_input = payload.get("tool_input") or {}
    if payload.get("tool_name") == "Bash":
        command = tool_input.get("command") or ""
        if ALLOWED.search(command):
            return None
        path = outside(command)
        if path is None:
            return None
        return (
            f"This command uses {path}, which is outside the session's scratchpad. Put "
            f"temporary files in the scratchpad directory the system prompt names (under "
            f"/private/tmp/claude-<uid>/), and branch work in a worktree beside the "
            f"repository. If the user asked for this path, or the command only mentions "
            f"it, run it again with TMP_OK=1 in front."
        )
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if as_path(path) is None:
        return None
    return (
        f"{path} is outside the session's scratchpad. Write the file in the scratchpad "
        f"directory the system prompt names (under /private/tmp/claude-<uid>/). If the "
        f"user asked for this path, write it from Bash with TMP_OK=1 in front."
    )


check = reason


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
