#!/usr/bin/env python3
"""Deny a verification run whose exit status a pipe would hide.

PreToolUse on Bash. `pytest -q | tail -3` exits with tail's status, so a failing run
reads as a pass. A command that pipes a test, lint, type or check run into a filter
(tail, head, grep, sed, awk, cut, sort, uniq, wc, tr, tee, less, more, cat) is denied
unless it also reads `$pipestatus` (`$PIPESTATUS` in bash) or sets `pipefail`.
Anything else prints nothing and goes through the usual permission flow.
"""
import json
import os
import re
import sys

# A command whose exit status says whether the code is right.
VERIFIER = re.compile(
    r"(?<![\w.-])(?:"
    r"pytest|py\.test|check\.sh|check-mods\.sh|revert_check\.py|knowledge_index\.py|test_\w+\.py|"
    r"python3?\s+-m\s+unittest|uv\s+lock\s+--check|mypy|pyright|ruff|flake8|lint-imports|"
    r"tsc|eslint|vitest|jest|mocha|"
    r"cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|"
    r"(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|typecheck)\w*)|node\s+--test|"
    r"make\s+(?:test|check|lint)|claude\s+plugin\s+(?:validate|test)"
    r")(?![\w-])"
)
# What reads the run's output and answers with its own status.
FILTERS = {
    "tail", "head", "grep", "egrep", "fgrep", "rg", "sed", "awk", "cut", "sort", "uniq",
    "wc", "tr", "tee", "less", "more", "cat", "column",
}
# A first word that only reads or prints text: a verifier named after it is an
# argument (`grep pytest`, `echo 'pytest | tail'`), not a run.
READERS = {
    "grep", "egrep", "fgrep", "rg", "cat", "echo", "printf", "ls", "find", "git", "sed",
    "awk", "head", "tail", "less", "more", "wc", "sort", "diff", "jq", "curl", "gh", "open",
    "which", "type", "pgrep", "ps", "man",
}
# Shell separators between commands; `||` splits before `|` does, and the `&` of a
# redirection (`2>&1`, `&>out`) or of `|&` is no separator.
SEPARATORS = re.compile(r"&&|\|\||[;\n]|(?<![<>|])&(?!>)")
# What the hook answers when check() gives a reason.
DECISION = "deny"


def starts_a_run(part):
    """True unless the pipeline's first command only reads or prints text, or asks a
    tool for its version or help."""
    words = [w for w in part.split() if not re.match(r"^\w+=", w)]
    if not words or os.path.basename(words[0]) in READERS:
        return False
    return not ({"--version", "--help", "-h", "-V"} & set(words))


def hidden(command):
    """(verifier, filter) when `command` pipes a verifier's output into a filter and
    never reads the verifier's own status, else None. The Bash tool runs zsh, whose
    array is `$pipestatus`; `$PIPESTATUS` counts only where bash runs the command."""
    if re.search(r"pipestatus|pipefail", command):
        return None
    if re.search(r"PIPESTATUS", command) and re.search(r"(?<![\w-])bash(?![\w-])", command):
        return None
    for segment in SEPARATORS.split(command):
        parts = segment.split("|")
        if len(parts) < 2 or not starts_a_run(parts[0]):
            continue
        run = VERIFIER.search(parts[0])
        if run is None:
            continue
        for part in parts[1:]:
            # `|&` pipes stderr too; the `&` is the operator's, not a word.
            words = part.lstrip(" &").split()
            if words and os.path.basename(words[0]) in FILTERS:
                return run.group(0), words[0]
    return None


def check(payload):
    """Why this tool call is denied, else None."""
    command = (payload.get("tool_input") or {}).get("command") or ""
    found = hidden(command)
    if found is None:
        return None
    verifier, flt = found
    return (
        f"This pipes {verifier} into {flt}, so the command's exit status is {flt}'s and a "
        f"failing run reads as a pass. Read the run's own status: append "
        f"`; echo \"exit: ${{pipestatus[1]}}\"` (zsh; `${{PIPESTATUS[0]}}` in bash), run it "
        f"with `set -o pipefail` first, or drop the pipe and read the whole output."
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
