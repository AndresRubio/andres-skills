"""Tests for pipe_guard.py. Run: python3 plugins/guards/tests/test_pipe_guard.py

Each test feeds the hook a Bash command and reads what it prints: nothing means "let it
through", JSON with permissionDecision "deny" means the pipe would hide a run's status.
"""
import json
import os
import subprocess
import sys
import unittest

_HOOK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "pipe_guard.py")


def decision(command):
    result = subprocess.run(
        [sys.executable, _HOOK],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}),
        capture_output=True, text=True, check=True,
    )
    if not result.stdout.strip():
        return None
    out = json.loads(result.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out["permissionDecisionReason"]


DENIED = [
    "uv run pytest -q | tail -3",
    "uv run pytest -q tests/test_x.py 2>&1 | tail -3",
    "bash scripts/check.sh 2>&1 | grep -E '^==>|passed'",
    "time bash scripts/check.sh 2>&1 | grep -E '^==>' | cut -c1-200",
    "uv run python scripts/revert_check.py abc123 --guard t 2>&1 | tail -25",
    "uv run mypy src | head -20",
    "uv run ruff check . | wc -l",
    "uv run lint-imports 2>&1 | grep -E 'KEPT|BROKEN'",
    "npm test 2>&1 | tail -20",
    "npm run lint | tee lint.log",
    "cargo test | grep -c ok",
    "claude plugin test . | tail -5",
    "cd /repo && uv run pytest -q | tail -3",
    "ls\nuv run pytest -q | tail -3",
    "echo start; uv run pytest -q 2>&1 | tail -3; echo done",
    "uv run pytest -q |& tail -3",
    # The Bash tool runs zsh, where PIPESTATUS is empty.
    "uv run pytest -q 2>&1 | tail -3; echo ${PIPESTATUS[0]}",
    "bash scripts/check-mods.sh check-gate 2>&1 | tail -3",
    "python3 ~/.claude/hooks/test_pipe_guard.py 2>&1 | tail -3",
    "python3 -m unittest discover | tail -5",
    "uv lock --check | head -2",
    "uv run python scripts/knowledge_index.py --check | tail -2",
]

PASSED = [
    "uv run pytest -q",
    "uv run pytest -q 2>&1 | tail -3; echo \"exit: ${pipestatus[1]}\"",
    "bash -c 'uv run pytest -q 2>&1 | tail -3; echo ${PIPESTATUS[0]}'",
    "set -o pipefail; uv run pytest -q | tail -3",
    "which pytest | head -1",
    "uv run pytest --version | head -1",
    "ruff --version | cat",
    "uv run pytest -q > out.txt 2>&1; tail -3 out.txt",
    "uv run pytest -q --durations=5",
    "grep -n pytest pyproject.toml | head -3",
    "cat scripts/check.sh | head -20",
    "git log --oneline -5 | cat",
    "uv run pytest -q || echo failed",
    "uv run pytest -q && git status | head -3",
    "echo 'uv run pytest | tail' > notes.txt",
    "ls | grep test",
    "",
]


class PipeGuardTest(unittest.TestCase):
    def test_a_verifier_piped_into_a_filter_is_denied(self):
        for command in DENIED:
            with self.subTest(command=command):
                got = decision(command)
                self.assertIsNotNone(got, command)
                self.assertEqual(got[0], "deny")
                self.assertIn("pipestatus", got[1])

    def test_a_run_whose_status_is_read_passes(self):
        for command in PASSED:
            with self.subTest(command=command):
                self.assertIsNone(decision(command), command)


if __name__ == "__main__":
    unittest.main()
