"""Tests for the commit mode of humanizer_check.py. Run: python3 plugins/humanizer/tests/test_humanizer_commit.py

Each test feeds the hook a Bash command and reads what it prints: nothing means "let it
through", JSON with permissionDecision "deny" means the message has a strong tell.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HOOK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "humanizer_check.py")
DASH = "—"


def decision(command, cwd):
    result = subprocess.run(
        [sys.executable, _HOOK, "commit"],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}),
        capture_output=True, text=True, check=True, cwd=cwd,
    )
    if not result.stdout.strip():
        return None
    out = json.loads(result.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out.get("permissionDecisionReason", "")


class CommitModeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", self.dir], check=True)
        with open(os.path.join(self.dir, "notes.md"), "w") as f:
            f.write(f"A body {DASH} with a dash\n")
        with open(os.path.join(self.dir, "clean.md"), "w") as f:
            f.write("A plain body.\n")

    def denied(self, command):
        got = decision(command, self.dir)
        self.assertIsNotNone(got, command)
        self.assertEqual(got[0], "deny", command)
        return got[1]

    def passed(self, command):
        self.assertIsNone(decision(command, self.dir), command)

    def test_a_tell_in_the_message_is_denied(self):
        for command in [
            f'git commit -m "Fix the gate {DASH} at last"',
            f'git commit -am "Fix the gate {DASH} at last"',
            f"git commit --message='Fix the gate {DASH} at last'",
            f"git commit -F - <<'EOF'\nFix the gate\n\nIt was {DASH} slow.\nEOF",
            f"git commit -F - <<<'Fix {DASH} it'",
            f'gh pr create --title "x" --body "A body {DASH} with a dash"',
            f'gh pr create -t "A title {DASH} dashed" -b "ok"',
            "gh pr edit 5 --body-file notes.md",
            f"cd {self.dir} && gh pr edit 5 --body-file notes.md",
            "git commit -F notes.md",
        ]:
            with self.subTest(command=command):
                reason = self.denied(command)
                self.assertIn("AI-writing tells", reason)

    def test_the_rest_of_the_command_is_never_read(self):
        for command in [
            'git checkout -- a.py && git commit -m "Move the gate"',
            f'git commit -m "Move the gate" -- "path {DASH} with a dash.md"',
            f'echo "a {DASH} b" > scratch.txt && git commit -m "Move the gate"',
            "git commit --amend --no-edit",
            "git commit -F - <<'EOF'\nMove the gate\n\nA plain body.\nEOF",
            "git -c user.name=AndresRubio commit -m 'Move the gate'",
            "gh pr edit 5 --body-file clean.md",
            f'HUMANIZER_OK=1 git commit -m "Quoted {DASH} on purpose"',
            f"git log --oneline -3 {DASH}",
        ]:
            with self.subTest(command=command):
                self.passed(command)

    def test_a_heredoc_feeding_a_file_the_commit_reads_still_counts(self):
        command = f"cat > m.txt <<'EOF'\nA line {DASH} here\nEOF\ngit commit -F m.txt"
        self.denied(command)

    def test_a_word_stuck_to_its_option_is_still_the_message(self):
        for command in [
            f'git commit -m"Fix the gate {DASH} at last"',
            f"git commit -mFix{DASH}it",
            f"git commit -m $'Fix the gate {DASH} at last\\n'",
        ]:
            with self.subTest(command=command):
                self.denied(command)

    def test_a_file_the_command_rewrites_is_read_from_the_body_not_the_disk(self):
        # notes.md on disk has a dash; the body written over it is clean.
        command = "cat > notes.md <<'EOF'\nA plain body.\nEOF\ngit commit -F notes.md"
        self.passed(command)

    def test_a_file_is_found_through_git_dash_c_and_a_relative_cd(self):
        sub = os.path.join(self.dir, "sub")
        os.mkdir(sub)
        with open(os.path.join(sub, "m.md"), "w") as f:
            f.write(f"Dashed {DASH} body\n")
        self.denied(f"git -C {sub} commit -F m.md")
        self.denied("git -C sub commit -F m.md")
        self.denied("cd sub && git commit -F m.md")
        self.denied(f"cd {sub} && git -c user.name=x -C . commit -F m.md")

    def test_body_file_is_not_read_as_an_inline_body(self):
        self.passed("gh pr edit 5 --body-file clean.md")
        self.denied("gh pr edit 5 --body-file notes.md")


if __name__ == "__main__":
    unittest.main()
