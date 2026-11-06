"""Tests for merge_guard.py. Run: python3 plugins/guards/tests/test_merge_guard.py

A stand-in `gh` on PATH answers from the FAKE_GH variable and writes down each call, so
the tests read both the hook's decision and what it asked GitHub.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

_HOOK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "merge_guard.py")

_FAKE_GH = '''#!/usr/bin/env python3
import json, os, sys
world = json.loads(os.environ["FAKE_GH"])
with open(world["log"], "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd()}) + "\\n")
kind = " ".join(sys.argv[1:3])
if kind in world.get("fail", []):
    sys.exit("gh: could not resolve to a PullRequest")
if kind == "pr view":
    print(json.dumps({"baseRefName": world["base"], "url": world.get("url", "https://github.com/me/repo/pull/16")}))
elif kind == "repo view":
    print(json.dumps({"defaultBranchRef": {"name": world.get("default", "main")}}))
else:
    sys.exit("unexpected gh call")
'''


class MergeGuardTest(unittest.TestCase):
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

    def decide(self, command, cwd=None, **world):
        env = dict(os.environ)
        env["PATH"] = self.bin + os.pathsep + env["PATH"]
        env["FAKE_GH"] = json.dumps({"log": self.log, "base": "main", **world})
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd or self.dir.name}
        result = subprocess.run(
            [sys.executable, _HOOK], input=json.dumps(payload),
            capture_output=True, text=True, check=True, env=env,
        )
        if not result.stdout.strip():
            return None
        out = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "deny")
        return out["permissionDecisionReason"]

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(line) for line in f]

    def test_a_merge_into_the_default_branch_passes(self):
        self.assertIsNone(self.decide("gh pr merge 16 --merge"))
        self.assertIsNone(self.decide("gh pr merge 16 --squash --delete-branch", base="trunk", default="trunk"))

    def test_a_merge_into_another_branch_is_denied(self):
        why = self.decide("gh pr merge 16 --merge", base="seam-fixes")
        self.assertIn("Pull request 16 merges into `seam-fixes`", why)
        self.assertIn("default branch is `main`", why)
        self.assertIn("gh pr edit 16 --base main", why)
        self.assertIn("MERGE_BASE_OK=1", why)

    def test_the_merge_is_found_wherever_the_command_runs_it(self):
        for command in [
            "gh pr checks 16 && gh pr merge 16 --merge",
            "echo start; gh  pr  merge 16 -d",
            "echo start;gh pr merge 16",
            "gh pr merge 3 --merge; gh pr merge 16 --merge",
            "git fetch\ngh pr merge 16 --merge",
            "(gh pr merge 16)",
            "echo $(gh pr merge 16)",
            "echo `gh pr merge 16`",
            "bash -c 'gh pr merge 16 --merge'",
            "zsh -lc \"cd . && gh pr merge 16\"",
            "time gh pr merge 16",
            "FOO=1 gh pr merge 16",
            "if true; then gh pr merge 16; fi",
            "/opt/homebrew/bin/gh pr merge 16",
            "gh pr -R me/repo merge 16",
            "gh -R me/repo pr merge 16",
            # A comment ends at its line, and a # inside a word is no comment.
            "cd .  # the worktree\ngh pr merge 16 --squash",
            "echo issue#3; gh pr merge 16",
            "timeout 60 gh pr merge 16",
            "env -u GH_TOKEN gh pr merge 16",
            "echo 16 | xargs -n1 gh pr merge",
            "\\gh pr merge 16",
            "eval 'gh pr merge 16'",
            "echo \"merged: $(gh pr merge 16)\"",
            "timeout 60 bash -c 'gh pr merge 16'",
            "echo 16 | xargs -I{} sh -c 'gh pr merge 16'",
            "uv run gh pr merge 16",
            "find . -maxdepth 0 -exec gh pr merge 16 \\;",
            "echo 'a`b'; echo `gh pr merge 16`",
            "bash <<EOF\ngh pr merge 16\nEOF",
            # A heredoc with an apostrophe is text, and the merge after it is still read.
            "gh pr comment 16 --body-file - <<'EOF'\nLGTM, it's ready.\nEOF\ngh pr merge 16 --squash",
        ]:
            with self.subTest(command=command):
                why = self.decide(command, base="seam-fixes")
                self.assertIsNotNone(why, command)
                self.assertIn("merges into `seam-fixes`", why)

    def test_the_user_can_merge_a_stacked_pull_request(self):
        for command in [
            "MERGE_BASE_OK=1 gh pr merge 16 --merge",
            "FOO=1 MERGE_BASE_OK=1 gh pr merge 16",
            "git fetch && MERGE_BASE_OK=1 gh pr merge 16",
            "MERGE_BASE_OK=1 bash -c 'gh pr merge 16'",
            "cd . && MERGE_BASE_OK=1 bash -c 'gh pr merge 16'",
        ]:
            with self.subTest(command=command):
                self.assertIsNone(self.decide(command, base="seam-fixes"))
        self.assertEqual(self.calls(), [])

    def test_the_words_of_the_escape_elsewhere_in_the_command_do_not_count(self):
        for command in [
            "echo MERGE_BASE_OK=1; gh pr merge 16",
            "gh pr merge 16 # MERGE_BASE_OK=1",
            "gh pr merge 16 --body MERGE_BASE_OK=1",
        ]:
            with self.subTest(command=command):
                self.assertIsNotNone(self.decide(command, base="seam-fixes"))

    def test_a_command_that_only_mentions_the_words_asks_github_nothing(self):
        for command in [
            "gh pr view 16", "gh pr list", "gh pr merge --help", "gh pr create --base main",
            "git merge seam-fixes", "echo gh pr merged", "gh pr merge-queue", "",
            "grep -n \"gh pr merge\" merge_guard.py",
            "git log --grep 'gh pr merge 12'",
            "echo gh pr merge 16",
            "gh issue create --title 'gh pr merge refuses stacked branches'",
            "gh pr comment 16 --body 'run gh pr merge 16 when green'",
            "rg 'gh pr merge' docs | head",
            "gh issue list --search merge",
            "gh repo view --json pr,merge",
            "ls  # then gh pr merge 16",
            "timeout 60 gh pr list",
            "xargs -n1 gh pr view",
            "gh pr comment 17 --body-file - <<'EOF'\nit's fine: run gh pr merge 12 later\nEOF",
            "gh pr create --body-file - <<EOF\ngh pr merge 12 is refused for a stacked branch\nEOF",
            "cat <<'EOF' > notes.md\ngh pr merge 12\nEOF",
            "find . -name gh",
            "uv run pytest -q",
        ]:
            with self.subTest(command=command):
                self.assertIsNone(self.decide(command, base="seam-fixes"))
        self.assertEqual(self.calls(), [])

    def test_the_pull_request_and_repo_named_in_the_command_are_the_ones_checked(self):
        asked = {
            "gh pr merge 16 -R me/other --merge -t 'Merge it' -b body": ["16", "--repo", "me/other"],
            "gh pr -R me/other merge 5": ["5", "--repo", "me/other"],
            "GH_REPO=me/other gh pr merge 5": ["5", "--repo", "me/other"],
            "GH_REPO=\"me/other\" gh pr merge 5": ["5", "--repo", "me/other"],
            "export GH_REPO=me/other; gh pr merge 5": ["5", "--repo", "me/other"],
            "export GH_REPO=me/other && bash -c 'gh pr merge 5'": ["5", "--repo", "me/other"],
            "env GH_REPO=me/other gh pr merge 5": ["5", "--repo", "me/other"],
            "gh pr merge --body=\"fix it\" 7": ["7", "--json", "baseRefName,url"],
            "gh pr merge --body \"x|y; z\" 7": ["7", "--json", "baseRefName,url"],
            "gh pr merge --body 'gh pr merge 99' 7": ["7", "--json", "baseRefName,url"],
            "gh pr merge 7 2>&1": ["7", "--json", "baseRefName,url"],
            "gh pr merge feature/x --squash": ["feature/x", "--json", "baseRefName,url"],
        }
        for command, words in asked.items():
            with self.subTest(command=command):
                if os.path.exists(self.log):
                    os.remove(self.log)
                self.decide(command)
                self.assertEqual(self.calls()[0]["argv"][:2 + len(words)], ["pr", "view", *words])
        os.remove(self.log)
        self.decide("gh pr merge --repo=me/other https://github.com/me/other/pull/4 --squash",
                    url="https://github.com/me/other/pull/4")
        first, second = self.calls()
        self.assertEqual(first["argv"][:5], ["pr", "view", "https://github.com/me/other/pull/4", "--repo", "me/other"])
        self.assertEqual(second["argv"][:3], ["repo", "view", "me/other"])

    def test_a_merge_with_no_number_asks_about_the_branch_checked_out(self):
        self.decide("gh pr merge --merge")
        self.assertEqual(self.calls()[0]["argv"], ["pr", "view", "--json", "baseRefName,url"])

    def test_the_default_branch_is_read_from_the_pull_requests_own_repo(self):
        self.decide("gh pr merge 2", url="https://ghe.example.com/team/app/pull/2")
        self.assertEqual(self.calls()[1]["argv"][:3], ["repo", "view", "ghe.example.com/team/app"])

    def test_github_is_asked_from_the_folder_the_command_moves_to(self):
        other = os.path.join(self.dir.name, "other")
        os.mkdir(other)
        for command in [f"cd {other} && gh pr merge --merge", "cd other && gh pr merge --merge",
                        "cd other\ngh pr merge", "cd 'other' && bash -c 'gh pr merge'",
                        "pushd other; gh pr merge"]:
            with self.subTest(command=command):
                if os.path.exists(self.log):
                    os.remove(self.log)
                self.assertIsNone(self.decide(command))
                self.assertEqual(os.path.realpath(self.calls()[0]["cwd"]), os.path.realpath(other))

    def test_a_folder_the_text_does_not_give_stops_a_merge_that_depends_on_it(self):
        for command in ["cd \"$WORKTREE\" && gh pr merge --merge", "cd $(git rev-parse --show-toplevel) && gh pr merge 16",
                        "cd no-such-folder && gh pr merge", "cd - && gh pr merge 16",
                        "cd \"$WORKTREE\" && bash -c 'gh pr merge 16'"]:
            with self.subTest(command=command):
                why = self.decide(command)
                self.assertIsNotNone(why, command)
                self.assertIn("Could not tell which folder this merge runs in", why)
                self.assertIn("MERGE_BASE_OK=1", why)
        self.assertEqual(self.calls(), [])

    def test_a_merge_that_names_its_repository_does_not_depend_on_the_folder(self):
        self.assertIsNone(self.decide("cd \"$WORKTREE\" && gh pr merge https://github.com/me/repo/pull/16"))
        self.assertIsNone(self.decide("cd \"$WORKTREE\" && gh pr merge 16 -R me/repo"))
        self.assertEqual(len(self.calls()), 4)

    def test_a_merge_after_a_heredoc_with_an_apostrophe_is_checked_like_any_other(self):
        command = "gh pr comment 17 --body-file - <<'EOF'\nLGTM, it's ready.\nEOF\ngh pr merge 17 --squash"
        self.assertIsNone(self.decide(command))
        self.assertEqual(self.calls()[0]["argv"][:3], ["pr", "view", "17"])

    def test_a_repository_the_text_computes_stops_the_merge(self):
        for command in ["GH_REPO=$(echo me/other) gh pr merge 5", "GH_REPO=\"$OTHER\" gh pr merge 5",
                        "gh pr merge 5 -R \"$OTHER\""]:
            with self.subTest(command=command):
                why = self.decide(command)
                self.assertIsNotNone(why, command)
                self.assertIn("Could not tell which repository this merge names", why)
        self.assertEqual(self.calls(), [])

    def test_a_quote_that_does_not_close_stops_a_command_that_may_merge(self):
        why = self.decide("gh pr merge 16 --body 'unclosed")
        self.assertIn("quote that does not close", why)
        self.assertIsNone(self.decide("echo 'unclosed"))
        self.assertEqual(self.calls(), [])

    def test_a_base_that_cannot_be_read_stops_the_merge(self):
        why = self.decide("gh pr merge 16 --merge", fail=["pr view"])
        self.assertIn("Could not check which branch this pull request merges into", why)
        self.assertIn("could not resolve to a PullRequest", why)
        self.assertIn("MERGE_BASE_OK=1", why)
        why = self.decide("gh pr merge 16 --merge", fail=["repo view"])
        self.assertIn("Could not check which branch pull request 16 merges into", why)

    def test_a_missing_gh_stops_the_merge(self):
        os.remove(os.path.join(self.bin, "gh"))
        env = {"PATH": self.bin, "FAKE_GH": "{}"}
        payload = {"tool_name": "Bash", "tool_input": {"command": "gh pr merge 16"}, "cwd": self.dir.name}
        result = subprocess.run(
            [sys.executable, _HOOK], input=json.dumps(payload),
            capture_output=True, text=True, check=True, env=env,
        )
        self.assertIn("Could not check", json.loads(result.stdout)["hookSpecificOutput"]["permissionDecisionReason"])


if __name__ == "__main__":
    unittest.main()
