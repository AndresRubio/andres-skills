"""Tests for guards.py, the one hook that runs every guard. Run: python3 plugins/guards/tests/test_guards.py

Most tests feed the hook a tool call and read what it prints: nothing means "let it
through", JSON carries the decision and the reasons. A stand-in `gh` on PATH answers
for GitHub, as in test_merge_guard.py, and writes down each call.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

_HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")
_HOOK = os.path.join(_HOOKS, "guards.py")
sys.path.insert(0, _HOOKS)
import discard_guard  # noqa: E402
import guards  # noqa: E402
import merge_guard  # noqa: E402
import message_guard  # noqa: E402
import pipe_guard  # noqa: E402
import tmp_guard  # noqa: E402
from test_message_guard import QUIET_GIT, make_repo  # noqa: E402

_FAKE_GH = '''#!/usr/bin/env python3
import json, os, sys, time
world = json.loads(os.environ["FAKE_GH"])
with open(world["log"], "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:]}) + "\\n")
time.sleep(world.get("sleep", 0))
kind = " ".join(sys.argv[1:3])
if kind == "pr view":
    print(json.dumps({"baseRefName": world["base"], "url": "https://github.com/me/repo/pull/16"}))
elif kind == "repo view":
    print(json.dumps({"defaultBranchRef": {"name": "main"}}))
else:
    sys.exit("unexpected gh call")
'''


def bash(command, cwd=None):
    return {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd or os.getcwd()}


def reason_of(guard, payload):
    why = guard.check(payload)
    assert why is not None, (guard.__name__, payload)
    return why


class GuardsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.bin = os.path.join(self.dir.name, "bin")
        os.mkdir(self.bin)
        path = os.path.join(self.bin, "gh")
        with open(path, "w") as f:
            f.write(_FAKE_GH)
        os.chmod(path, 0o755)
        self.log = os.path.join(self.dir.name, "calls.jsonl")
        self.world = {"log": self.log, "base": "main"}

    def run_hook(self, payload, mode="bash", raw=None):
        env = dict(os.environ)
        env["PATH"] = self.bin + os.pathsep + env["PATH"]
        env["FAKE_GH"] = json.dumps(self.world)
        return subprocess.run(
            [sys.executable, _HOOK, *([mode] if mode else [])],
            input=raw if raw is not None else json.dumps(payload),
            capture_output=True, text=True, env=env,
        )

    def decide(self, payload, mode="bash"):
        result = self.run_hook(payload, mode)
        self.assertEqual(result.returncode, 0, result.stderr)
        if not result.stdout.strip():
            return None
        out = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "PreToolUse")
        return out["permissionDecision"], out["permissionDecisionReason"]

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(line) for line in f]

    def test_a_clean_command_prints_nothing_and_asks_github_nothing(self):
        for command in ["uv run pytest -q", "git status", "ls -la", "",
                        "gh pr view 16", "echo gh pr merge 16"]:
            with self.subTest(command=command):
                result = self.run_hook(bash(command, self.dir.name))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")
        self.assertEqual(self.calls(), [])

    def test_one_objection_is_passed_on_word_for_word(self):
        cases = [
            (discard_guard, "ask", "git reset --hard"),
            (pipe_guard, "deny", "uv run pytest -q | tail -3"),
            (tmp_guard, "deny", "cp a /tmp/x"),
            (merge_guard, "deny", "cd \"$WORKTREE\" && gh pr merge 16"),
        ]
        for guard, decision, command in cases:
            with self.subTest(guard=guard.__name__):
                payload = bash(command, self.dir.name)
                self.assertEqual(self.decide(payload), (decision, reason_of(guard, payload)))

    def test_a_deny_wins_over_an_ask_and_both_reasons_are_shown(self):
        payload = bash("cd /tmp; git checkout -- a.py", self.dir.name)
        decision, why = self.decide(payload)
        self.assertEqual(decision, "deny")
        self.assertEqual(why, reason_of(discard_guard, payload) + "\n\n" + reason_of(tmp_guard, payload))

    def test_the_bash_checks_run_in_order_with_the_merge_check_last(self):
        self.assertEqual(guards.MODES["bash"],
                         ("discard_guard", "pipe_guard", "tmp_guard", "message_guard", "merge_guard"))
        self.assertEqual(guards.MODES["files"], ("tmp_guard",))

    def test_a_repeated_commit_message_is_denied_after_the_tmp_reason(self):
        repo = make_repo(os.path.join(os.path.realpath(self.dir.name), "repo"), "Count the words\n")
        payload = bash("git commit -m 'Count the words' && ls /tmp/x", repo)
        with mock.patch.dict(os.environ, QUIET_GIT):
            expected = [reason_of(tmp_guard, payload), reason_of(message_guard, payload)]
            decision, why = self.decide(payload)
        self.assertEqual(decision, "deny")
        self.assertEqual(why, "\n\n".join(expected))
        self.assertIn("REPEAT_MESSAGE_OK=1", why)
        with mock.patch.dict(os.environ, QUIET_GIT):
            self.assertIsNone(self.decide(bash("REPEAT_MESSAGE_OK=1 git commit -m 'Count the words'", repo)))

    def test_two_asks_stay_an_ask(self):
        objections = [("ask", "first"), ("ask", "second")]
        out = guards.combined(objections)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "ask")
        self.assertEqual(out["permissionDecisionReason"], "first\n\nsecond")
        self.assertIsNone(guards.combined([]))

    def test_every_objecting_guard_gives_its_reason_in_order(self):
        payload = bash("git reset --hard; uv run pytest -q | tail -1 > /tmp/out.log", self.dir.name)
        decision, why = self.decide(payload)
        self.assertEqual(decision, "deny")
        self.assertEqual(why, "\n\n".join(reason_of(g, payload) for g in (discard_guard, pipe_guard, tmp_guard)))

    def test_a_merge_check_joins_the_other_reasons(self):
        self.world["base"] = "seam-fixes"
        payload = bash("cp a /tmp/x && gh pr merge 16 --merge", self.dir.name)
        decision, why = self.decide(payload)
        self.assertEqual(decision, "deny")
        first, second = why.split("\n\n")
        self.assertIn("/tmp/x", first)
        self.assertIn("Pull request 16 merges into `seam-fixes`", second)
        self.assertEqual(len(self.calls()), 2)

    def test_the_escapes_still_work_and_only_for_their_own_guard(self):
        self.assertIsNone(self.decide(bash("TMP_OK=1 ls /tmp", self.dir.name)))
        self.world["base"] = "seam-fixes"
        self.assertIsNone(self.decide(bash("MERGE_BASE_OK=1 gh pr merge 16", self.dir.name)))
        decision, why = self.decide(bash("TMP_OK=1 git reset --hard", self.dir.name))
        self.assertEqual(decision, "ask")
        decision, why = self.decide(bash("MERGE_BASE_OK=1 cp a /tmp/x", self.dir.name))
        self.assertEqual(decision, "deny")
        self.assertIn("TMP_OK=1", why)

    def test_the_files_mode_runs_only_the_tmp_check(self):
        denied = {"tool_name": "Write", "tool_input": {"file_path": "/tmp/notes.md", "content": "x"}}
        self.assertEqual(self.decide(denied, "files"), ("deny", reason_of(tmp_guard, denied)))
        passed = {"tool_name": "Edit", "tool_input": {"file_path": "/Users/me/a.py", "old_string": "a",
                                                      "new_string": "git reset --hard | tail"}}
        self.assertIsNone(self.decide(passed, "files"))
        # A Bash call sent to the files hook is read by tmp_guard alone.
        self.assertIsNone(self.decide(bash("git reset --hard", self.dir.name), "files"))

    def test_input_that_is_not_json_is_a_hook_error_that_lets_the_call_run(self):
        for raw in ["", "not json", "{\"tool_name\": ", "\xff"]:
            with self.subTest(raw=raw):
                result = self.run_hook(None, raw=raw)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertIn("not JSON", result.stderr)

    def test_input_of_the_wrong_shape_is_a_hook_error_that_lets_the_call_run(self):
        for raw in ["[]", "null", "\"ls /tmp\"", "{\"tool_input\": \"ls /tmp\"}",
                    "{\"tool_name\": \"Bash\", \"tool_input\": {\"command\": 5}}"]:
            with self.subTest(raw=raw):
                result = self.run_hook(None, raw=raw)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertEqual(result.stdout, "")
                self.assertIn("Traceback", result.stderr)

    def test_an_unknown_mode_blocks_the_call(self):
        for mode in ["", "Bash", "write"]:
            with self.subTest(mode=mode):
                result = self.run_hook(bash("ls"), mode=mode)
                self.assertEqual(result.returncode, 2)
                self.assertIn("unknown mode", result.stderr)

    def test_a_guard_that_raises_does_not_hide_another_guards_answer(self):
        payload = bash("git reset --hard /tmp/x", self.dir.name)
        with mock.patch.object(pipe_guard, "check", side_effect=RuntimeError("boom")):
            objections, errors = guards.evaluate("bash", payload)
        self.assertEqual([d for d, _ in objections], ["ask", "deny"])
        self.assertEqual(len(errors), 1)
        self.assertIn("boom", errors[0])
        with mock.patch.object(discard_guard, "check", side_effect=RuntimeError("boom")):
            # The folder is a variable, so merge_guard denies without asking GitHub.
            objections, errors = guards.evaluate("bash", bash("cd \"$WORKTREE\" && ls /tmp/x && gh pr merge 16"))
        self.assertEqual([d for d, _ in objections], ["deny", "deny"])
        self.assertIn("Could not tell which folder", objections[1][1])

    def test_a_guard_that_cannot_be_imported_stops_only_itself(self):
        real = guards.importlib.import_module

        def broken(name):
            if name == "pipe_guard":
                raise SyntaxError("pipe_guard.py is broken")
            return real(name)

        payload = bash("uv run pytest -q | tail -3 > /tmp/out.log; git reset --hard", self.dir.name)
        with mock.patch.object(guards.importlib, "import_module", side_effect=broken):
            objections, errors = guards.evaluate("bash", payload)
        self.assertEqual(objections, [("ask", reason_of(discard_guard, payload)),
                                      ("deny", reason_of(tmp_guard, payload))])
        self.assertEqual(len(errors), 1)
        self.assertIn("pipe_guard.py is broken", errors[0])

    def test_a_guard_that_raises_with_no_other_objection_exits_1(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(tmp_guard, "check", side_effect=RuntimeError("boom")), \
                mock.patch("sys.stdin", io.StringIO(json.dumps(bash("ls")))), \
                mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", stderr):
            code = guards.main(["guards.py", "bash"])
        self.assertEqual(code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("tmp_guard", stderr.getvalue())

    def test_a_merge_check_past_the_deadline_is_denied_and_the_others_still_answer(self):
        self.world.update(base="seam-fixes", sleep=30)
        env = {"PATH": self.bin + os.pathsep + os.environ["PATH"], "FAKE_GH": json.dumps(self.world)}
        payload = bash("ls /tmp/x; gh pr merge 16", self.dir.name)
        started = time.monotonic()
        with mock.patch.dict(os.environ, env):
            objections, errors = guards.evaluate("bash", payload, deadline=1)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(errors, [])
        self.assertEqual(objections, [("deny", reason_of(tmp_guard, payload)), ("deny", guards.OUT_OF_TIME)])
        self.assertEqual(len(self.calls()), 1)

    def test_the_hook_timeout_leaves_room_after_the_merge_deadline(self):
        with open(os.path.join(_HOOKS, "hooks.json")) as f:
            wiring = json.load(f)["hooks"]["PreToolUse"]
        by_matcher = {entry["matcher"]: entry["hooks"] for entry in wiring}
        self.assertEqual(set(by_matcher), {"Bash", "Write|Edit|MultiEdit|NotebookEdit"})
        (bash_hook,) = by_matcher["Bash"]
        (files_hook,) = by_matcher["Write|Edit|MultiEdit|NotebookEdit"]
        self.assertTrue(bash_hook["command"].endswith("/hooks/guards.py\" bash"))
        self.assertTrue(files_hook["command"].endswith("/hooks/guards.py\" files"))
        self.assertGreaterEqual(bash_hook["timeout"] - guards.MERGE_DEADLINE, 5)


if __name__ == "__main__":
    unittest.main()
