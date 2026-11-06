"""Tests for discard_guard.py. Run: python3 plugins/guards/tests/test_discard_guard.py

Each test feeds the hook a Bash command and reads what it prints: nothing means "let it
through", JSON with permissionDecision "ask" means a person must approve it.
"""
import json
import os
import subprocess
import sys
import unittest

_HOOK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "discard_guard.py")


def decision(command):
    result = subprocess.run(
        [sys.executable, _HOOK],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}),
        capture_output=True, text=True, check=True,
    )
    if not result.stdout.strip():
        return None
    return json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"]


ASKED = [
    "git checkout -- src/axial/gate.py",
    "git checkout HEAD -- src/axial/gate.py",
    "git checkout main -- a.py b.py",
    "git checkout .",
    "git checkout -f other-branch",
    "git restore src/axial/gate.py",
    "git restore --worktree --staged a.py",
    "git restore -SW a.py",
    "git restore --source=HEAD~1 a.py",
    "git reset --hard",
    "git reset --hard origin/main",
    "git clean -fd",
    "git clean -xdf",
    "git clean --force",
    "git switch -f main",
    "git switch --discard-changes main",
    "cd /Users/x/evals-cli-errors && git checkout -- src/axial/gate.py",
    "cd /tmp; git -C ../repo checkout -- a.py",
    "git -c core.pager=cat restore a.py",
    "ls\ngit checkout -- a.py",
    "/usr/bin/git restore a.py",
    "uv run ruff check . && git checkout -- a.py 2>/dev/null",
]

PASSED = [
    "git status",
    "git checkout -b new-branch",
    "git checkout main",
    "git switch main",
    "git restore --staged a.py",
    "git restore -S a.py",
    "git reset HEAD~1",
    "git reset --soft HEAD~1",
    "git clean -n",
    "git clean -fn",
    "git clean --dry-run --force",
    "git diff -- a.py",
    "git log --oneline -- a.py",
    "git stash push -u -m tag",
    "echo checkout -- a.py",
    "git commit -m 'restore the checkout docs'",
    "",
]


class DiscardGuardTest(unittest.TestCase):
    def test_commands_that_throw_work_away_are_asked(self):
        for command in ASKED:
            with self.subTest(command=command):
                self.assertEqual(decision(command), "ask")

    def test_commands_that_keep_the_working_tree_pass(self):
        for command in PASSED:
            with self.subTest(command=command):
                self.assertIsNone(decision(command))


if __name__ == "__main__":
    unittest.main()
