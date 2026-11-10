"""Tests for tmp_guard.py. Run: python3 plugins/guards/tests/test_tmp_guard.py

Each test feeds the hook a tool call and reads what it prints: nothing means "let it
through", JSON with permissionDecision "deny" means the call uses /tmp outside Claude
Code's own folder.
"""
import json
import os
import subprocess
import sys
import unittest

_HOOK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "tmp_guard.py")
_SCRATCH = "/private/tmp/claude-501/-Users-me-repo/0f5a05a9/scratchpad"


def decision(tool_name, tool_input):
    result = subprocess.run(
        [sys.executable, _HOOK],
        input=json.dumps({"tool_name": tool_name, "tool_input": tool_input}),
        capture_output=True, text=True, check=True,
    )
    if not result.stdout.strip():
        return None
    out = json.loads(result.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out["permissionDecisionReason"]


DENIED = [
    "cp src/store.py /tmp/store.bak",
    "uv run pytest -q > /tmp/out.log 2>&1",
    "bash scripts/check.sh > /private/tmp/check.log",
    "git worktree add /tmp/evals-fix -b fix",
    "git -C /tmp/repo status",
    "cd /tmp && git init demo",
    "ls /tmp",
    "echo x > '/tmp/a b.txt'",
    "tee \"/tmp/x.log\"",
    "python3 -c 'open(\"/tmp/x\", \"w\")'",
    "mkdir -p /var/tmp/work",
    "cat <<EOF > /tmp/notes.md\nhello\nEOF",
    "ls /tmp/claude-501-old/x",
    "touch /tmp/claude-501/../evil",
    "tool --out=/tmp/x.json",
    "LOG=/tmp/run.log make build",
    "run 2>/tmp/err.log",
    "(cd /tmp; ls)",
    "wc -l $(cat /tmp/list)",
    "ls $(echo /tmp)",
    "out=${TMPDIR:-/tmp}/x; touch $out",
    "touch ${HOME:+/tmp}/x",
    "curl -o/tmp/x https://example.com",
    "tar -C/tmp -xf a.tgz",
    "python3 - <<'PY'\nopen('/tmp/x', 'w')\nPY",
    "bash <<EOF\ncp a /tmp/x\nEOF",
    "curl -d @/tmp/body https://example.com",
    "cp a {/tmp,/var/tmp}/x",
    "PATH=$PATH:/tmp/bin run",
    # A # inside a word is no comment, and a comment ends at its line.
    "echo $# ; cp a /tmp/x",
    "ls ${#arr} /tmp/x",
    "ls  # list first\ncp a /tmp/x",
    "echo \"saved to $(mktemp -p /tmp)\"",
    "gh issue create --title 'stop writing to /tmp/x'",
    # The escape is honoured in front of the command and nowhere else.
    "echo TMP_OK=1; rm -rf /tmp/x",
    "ls /tmp # TMP_OK=1",
    # Quotes that never close: the text is searched as it stands.
    "echo 'unclosed > /tmp/x",
    f"cp {_SCRATCH}/a.py /tmp/a.py",
]

PASSED = [
    f"cp src/store.py {_SCRATCH}/store.bak",
    f"uv run pytest -q > {_SCRATCH}/out.log 2>&1",
    "ls /tmp/claude-501/bundled-skills/2.1.317",
    "cat /private/tmp/claude-501/-Users-me-repo/0f5a05a9/scratchpad/x.py",
    "ls ~/tmp ./tmp $HOME/tmp ${dir}/tmp $(pwd)/tmp /Users/me/tmp",
    "ls build/tmp/cache my-tmp /tmpfiles /tmp-old",
    "TMP_OK=1 ls /tmp",
    "FOO=1 TMP_OK=1 ls /tmp",
    "find . -path '*/tmp/*' -prune",
    "mkdir -p \"$out\"/tmp",
    "ls build/[ab]/tmp build/?/tmp",
    "rsync -a host:/srv/tmp/ ./copy",
    "curl -s https://example.com/tmp/file",
    "ls  # was in /tmp before",
    "cd $(pwd)/tmp && ls `pwd`/tmp",
    "scp host:backup.tgz ./tmp/",
    "cat <<'EOF' > notes.md\nit's kept in ./tmp/cache and ~/tmp\nEOF",
    "tar -C/Users/me/tmp -xf a.tgz",
    "mktemp -d",
    "uv run pytest -q",
    "",
]

FILES_DENIED = [
    ("Write", {"file_path": "/tmp/notes.md", "content": "x"}),
    ("Edit", {"file_path": "/private/tmp/notes.md", "old_string": "a", "new_string": "b"}),
    ("NotebookEdit", {"notebook_path": "/tmp/a.ipynb", "new_source": "x"}),
    ("MultiEdit", {"file_path": "/var/tmp/a.py", "edits": []}),
    ("Write", {"file_path": "/tmp/claude-501/../notes.md", "content": "x"}),
]

FILES_PASSED = [
    ("Write", {"file_path": f"{_SCRATCH}/notes.md", "content": "mentions /tmp/x in its text"}),
    ("Write", {"file_path": "/Users/me/repo/tmp/notes.md", "content": "x"}),
    ("Edit", {"file_path": "/Users/me/repo/a.py", "old_string": "/tmp/a", "new_string": "/tmp/b"}),
]


class TmpGuardTest(unittest.TestCase):
    def test_a_command_that_uses_tmp_is_denied(self):
        for command in DENIED:
            with self.subTest(command=command):
                got = decision("Bash", {"command": command})
                self.assertIsNotNone(got, command)
                self.assertEqual(got[0], "deny")
                self.assertIn("scratchpad", got[1])
                self.assertIn("TMP_OK=1", got[1])

    def test_a_command_that_stays_out_of_tmp_passes(self):
        for command in PASSED:
            with self.subTest(command=command):
                self.assertIsNone(decision("Bash", {"command": command}), command)

    def test_a_file_written_to_tmp_is_denied(self):
        for tool_name, tool_input in FILES_DENIED:
            with self.subTest(tool=tool_name):
                got = decision(tool_name, tool_input)
                self.assertIsNotNone(got, tool_name)
                self.assertEqual(got[0], "deny")
                self.assertIn("scratchpad", got[1])

    def test_a_file_written_elsewhere_passes(self):
        for tool_name, tool_input in FILES_PASSED:
            with self.subTest(tool=tool_name, path=tool_input.get("file_path")):
                self.assertIsNone(decision(tool_name, tool_input))


if __name__ == "__main__":
    unittest.main()
