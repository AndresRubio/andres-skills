#!/usr/bin/env python3
"""Script tests for `cleanup.py scan`. Run them with the interpreter the skill
meets on a Mac, the system python3 (3.9):

    python3 skills/cleanup/evals/test_scan.py

Each test class builds the shared fixture (fixtures/make_fixture.sh) in a
temporary folder, adds what it needs, and reads the plan JSON that `scan`
writes. Nothing outside the temporary folder is touched.
"""

import datetime as dt
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "cleanup.py")
MAKE_FIXTURE = os.path.join(HERE, "fixtures", "make_fixture.sh")
ENV = dict(
    os.environ,
    GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null",
    GIT_AUTHOR_NAME="Fixture", GIT_AUTHOR_EMAIL="fixture@example.com",
    GIT_COMMITTER_NAME="Fixture", GIT_COMMITTER_EMAIL="fixture@example.com",
)


def load_cleanup():
    spec = importlib.util.spec_from_file_location("cleanup", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sh(*cmd, cwd=None):
    subprocess.run(cmd, cwd=cwd, env=ENV, check=True, capture_output=True, text=True)


def run_scan(dest, *args):
    """Run scan on DEST/demo-app; return (process, plan or None)."""
    out = os.path.join(dest, "plan.json")
    if os.path.exists(out):
        os.remove(out)
    p = subprocess.run(
        [sys.executable, SCRIPT, "scan", "--repo", os.path.join(dest, "demo-app"),
         "--no-fetch", "--out", out, *args],
        env=ENV, capture_output=True, text=True,
    )
    plan = None
    if p.returncode == 0:
        with open(out) as f:
            plan = json.load(f)
    return p, plan


def item_at(plan, path):
    want = os.path.realpath(path)
    return next(i for i in plan["items"] if i.get("path") and os.path.realpath(i["path"]) == want)


class FixtureCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dest = os.path.realpath(tempfile.mkdtemp(prefix="cleanup-test-"))
        sh("bash", MAKE_FIXTURE, cls.dest, "--no-squash")
        cls.repo = os.path.join(cls.dest, "demo-app")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dest, ignore_errors=True)

    def scan_ok(self, *args):
        p, plan = run_scan(self.dest, *args)
        self.assertEqual(p.returncode, 0, p.stderr)
        return plan


class SinceTests(FixtureCase):
    """--since takes the ISO 8601 forms an agent writes, on Python 3.9 too, where
    datetime.fromisoformat rejects a trailing Z."""

    def test_parse_since_forms(self):
        parse = load_cleanup().parse_since
        utc = dt.datetime(2026, 10, 28, 8, 50, tzinfo=dt.timezone.utc).timestamp()
        same = [
            "2026-10-28T08:50:00Z", "2026-10-28T08:50:00z", "2026-10-28T08:50Z",
            "2026-10-28T08:50:00+00:00", "2026-10-28T09:50:00+01:00", "2026-10-28T09:50:00+0100",
            "2026-10-28T09:50:00+01", "2026-10-28T03:50:00-05:00", "2026-10-28 08:50:00Z",
            "20261028T085000Z", " 2026-10-28T08:50:00Z\n",
        ]
        for text in same:
            with self.subTest(text=text):
                self.assertEqual(parse(text), utc)
        fractions = {
            "2026-10-28T08:50:00.123Z": 0.123,
            "2026-10-28T08:50:00,5Z": 0.5,
            "2026-10-28T08:50:00.123456789Z": 0.123456,
        }
        for text, extra in fractions.items():
            with self.subTest(text=text):
                self.assertAlmostEqual(parse(text), utc + extra, places=6)
        # No offset means local time, as before.
        self.assertEqual(parse("2026-10-28T08:50:00"), dt.datetime(2026, 10, 28, 8, 50).timestamp())
        self.assertEqual(parse("2026-10-28"), dt.datetime(2026, 10, 28).timestamp())

    def test_parse_since_rejects_non_times(self):
        cleanup = load_cleanup()
        for text in ("yesterday", "", "2026-13-01T00:00Z", "2026-10-28T25:00Z", "2026-10-28T08:50+24:00"):
            with self.subTest(text=text):
                with self.assertRaises(cleanup.argparse.ArgumentTypeError) as ctx:
                    cleanup.parse_since(text)
                self.assertIn(repr(text), str(ctx.exception))

    def test_scan_reads_trailing_z(self):
        hour_ago = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
        for since in (hour_ago.strftime("%Y-%m-%dT%H:%M:%SZ"),
                      hour_ago.strftime("%Y-%m-%dT%H:%M:%S.") + "123Z"):
            with self.subTest(since=since):
                plan = self.scan_ok("--since", since)
                self.assertEqual(item_at(plan, os.path.join(self.repo, "tmp-output.log"))["verdict"], "ask")
                self.assertEqual(item_at(plan, os.path.join(self.repo, "old-draft.txt"))["verdict"], "keep")

    def test_bad_since_is_a_usage_error(self):
        p, _ = run_scan(self.dest, "--since", "yesterday")
        self.assertEqual(p.returncode, 2)
        self.assertIn("--since", p.stderr)
        self.assertNotIn("Traceback", p.stderr)


class OutsideWorktreeTests(FixtureCase):
    """A worktree outside .claude/worktrees is out of scope, and so is any
    worktree an installed skill links into, whatever its branch."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Like ~/Desktop/projects/andres-skills-confession-box: a hand-made
        # worktree next to the repo, its branch merged and pushed.
        cls.outside = os.path.join(cls.dest, "demo-app-thing")
        sh("git", "worktree", "add", "-q", "-b", "add-thing", cls.outside, "main", cwd=cls.repo)
        os.makedirs(os.path.join(cls.outside, "skills", "thing"))
        with open(os.path.join(cls.outside, "skills", "thing", "SKILL.md"), "w") as f:
            f.write("---\nname: thing\n---\n")
        sh("git", "add", "-A", cwd=cls.outside)
        sh("git", "commit", "-qm", "Add thing skill", cwd=cls.outside)
        sh("git", "push", "-q", "-u", "origin", "add-thing", cwd=cls.outside)
        sh("git", "merge", "-q", "--no-ff", "-m", "Merge add-thing", "add-thing", cwd=cls.repo)
        sh("git", "push", "-q", "origin", "main", cwd=cls.repo)
        cls.merged_feature = os.path.join(cls.repo, ".claude", "worktrees", "merged-feature")

        # Three stand-ins for ~/.claude/skills.
        cls.skills_none = os.path.join(cls.dest, "skills-none")
        os.makedirs(os.path.join(cls.skills_none, "plain-skill"))
        os.symlink(os.path.join(cls.dest, "notes"), os.path.join(cls.skills_none, "notes"))
        cls.skills_outside = os.path.join(cls.dest, "skills-outside")
        os.makedirs(cls.skills_outside)
        cls.outside_link = os.path.join(cls.skills_outside, "thing")
        os.symlink(os.path.join(cls.outside, "skills", "thing"), cls.outside_link)
        cls.skills_inside = os.path.join(cls.dest, "skills-inside")
        os.makedirs(cls.skills_inside)
        cls.inside_link = os.path.join(cls.skills_inside, "feature")
        os.symlink(os.path.join(cls.merged_feature, "src"), cls.inside_link)

    def test_outside_worktree_kept_even_when_its_branch_is_named(self):
        for args in ((), ("--branch", "add-thing")):
            with self.subTest(args=args):
                plan = self.scan_ok("--skills-dir", self.skills_none, *args)
                item = item_at(plan, self.outside)
                self.assertEqual(item["verdict"], "keep")
                self.assertIn(".claude/worktrees", item["reason"])
                self.assertEqual(item["actions"], [])
                # The fix must not make in-scope worktrees sticky.
                self.assertEqual(item_at(plan, self.merged_feature)["verdict"], "safe")

    def test_remote_copy_of_a_kept_worktree_branch_reads_as_merged(self):
        plan = self.scan_ok("--skills-dir", self.skills_none, "--branch", "add-thing")
        rb = next(i for i in plan["items"] if i["kind"] == "remote-branch" and i["branch"] == "add-thing")
        self.assertEqual(rb["verdict"], "ask")
        self.assertTrue(rb["merged"])
        self.assertIn("merged", rb["reason"])
        self.assertFalse(any(i["kind"] == "branch" and i["branch"] == "add-thing" for i in plan["items"]))

    def test_skill_link_keeps_the_outside_worktree(self):
        plan = self.scan_ok("--skills-dir", self.skills_outside, "--branch", "add-thing")
        item = item_at(plan, self.outside)
        self.assertEqual(item["verdict"], "keep")
        self.assertIn(self.outside_link, item["reason"])

    def test_skill_link_keeps_a_merged_session_worktree(self):
        plan = self.scan_ok("--skills-dir", self.skills_inside)
        item = item_at(plan, self.merged_feature)
        self.assertEqual(item["verdict"], "keep")
        self.assertIn(self.inside_link, item["reason"])
        p = subprocess.run(
            [sys.executable, SCRIPT, "apply", os.path.join(self.dest, "plan.json"),
             "--ids", item["id"], "--dry-run"],
            env=ENV, capture_output=True, text=True,
        )
        self.assertEqual(p.returncode, 1)
        self.assertIn("refusing", p.stdout)
        self.assertTrue(os.path.isdir(self.merged_feature))


if __name__ == "__main__":
    unittest.main()
