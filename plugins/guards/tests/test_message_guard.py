"""Tests for message_guard.py. Run: python3 plugins/guards/tests/test_message_guard.py

Each test builds real git repositories in a temporary folder, with git's own config
files turned off so the machine's settings change nothing, and asks the guard about a
command run there.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
import message_guard  # noqa: E402

TITLE = "Teach the parser heredocs"
BODY = "The body is kept on the command it feeds."
LAST = f"{TITLE}\n\n{BODY}\n"
# git reads none of the machine's config, and finds no repository above the test's folder.
QUIET_GIT = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def git(folder, *args, stdin=None):
    return subprocess.run(
        ["git", "-C", folder, "-c", "user.name=T", "-c", "user.email=t@example.com",
         "-c", "commit.gpgsign=false", *args],
        input=stdin, check=True, capture_output=True, text=True,
    ).stdout


def make_repo(folder, message=None):
    """A repository in `folder`, with one commit carrying `message` unless it is None."""
    os.makedirs(folder, exist_ok=True)
    git(folder, "init", "-q")
    if message is not None:
        with open(os.path.join(folder, "a.txt"), "w") as f:
            f.write("a\n")
        git(folder, "add", "a.txt")
        git(folder, "commit", "-q", "-F", "-", stdin=message)
    return folder


def bash(command, cwd):
    return {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}


class MessageGuardTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = root = os.path.realpath(self.dir.name)
        env = dict(QUIET_GIT, GIT_CEILING_DIRECTORIES=root)
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("GIT_DIR", "GIT_WORK_TREE"):
            os.environ.pop(name, None)
        self.repo = make_repo(os.path.join(root, "repo"), LAST)
        self.short = git(self.repo, "log", "-1", "--format=%h").strip()

    def check(self, command, cwd=None):
        return message_guard.check(bash(command, cwd or self.repo))

    def assert_denied(self, command, cwd=None):
        why = self.check(command, cwd)
        self.assertIsNotNone(why, command)
        return why

    def write(self, name, text, folder=None):
        path = os.path.join(folder or self.repo, name)
        with open(path, "w", newline="") as f:
            f.write(text)
        return path

    def test_the_same_message_with_m_is_denied(self):
        self.assert_denied(f"git commit -m '{TITLE}\n\n{BODY}'")
        self.assert_denied(f"git add a.txt && git commit -q -m \"{TITLE}\n\n{BODY}\n\"")

    def test_two_m_values_are_joined_by_a_blank_line(self):
        self.assert_denied(f"git commit -m '{TITLE}' -m '{BODY}'")
        self.assert_denied(f"git commit -am '{TITLE}' --message='{BODY}'")
        self.assert_denied(f"git commit -m'{TITLE}' --mess '{BODY}'")
        self.assertIsNone(self.check(f"git commit -m '{TITLE}' -m '{BODY}' -m 'One more line.'"))
        self.assertIsNone(self.check(f"git commit -m '{TITLE}'"))

    def test_the_same_message_from_a_file_is_denied(self):
        # Trailing spaces, CRLF and trailing blank lines do not make it another message.
        self.write("cm.txt", f"{TITLE}  \r\n\r\n{BODY}\r\n\r\n\r\n")
        self.assert_denied("git commit -F cm.txt")
        self.assert_denied("git commit --file=cm.txt")
        os.mkdir(os.path.join(self.repo, "sub"))
        self.assert_denied("cd sub && git commit -F ../cm.txt")
        self.assert_denied(f"cd sub && git commit -F {self.repo}/cm.txt")

    def test_the_same_message_from_a_heredoc_or_here_string_is_denied(self):
        self.assert_denied(f"git commit -F - <<'EOF'\n{TITLE}\n\n{BODY}\nEOF")
        self.assert_denied(f"git commit -F - <<EOF\n{TITLE}\n\n{BODY}\nEOF\necho done")
        self.assert_denied(f"git commit -F - <<< '{TITLE}\n\n{BODY}'")

    def test_the_reason_says_what_happened_and_what_to_do(self):
        why = self.assert_denied(f"git commit -m '{TITLE}' -m '{BODY}'")
        self.assertIn(f"`{self.short} {TITLE}`", why)
        self.assertIn("same as the last commit's", why)
        self.assertIn("refused", why)
        self.assertIn("REPEAT_MESSAGE_OK=1", why)

    def test_a_different_message_is_allowed(self):
        self.assertIsNone(self.check("git commit -m 'Read here-strings too'"))
        self.write("cm.txt", f"{TITLE}\n\nAnother body.\n")
        self.assertIsNone(self.check("git commit -F cm.txt"))
        self.assertIsNone(self.check(f"git commit -F - <<'EOF'\n{TITLE}\nEOF"))

    def test_a_commit_that_repeats_or_edits_a_message_on_purpose_is_allowed(self):
        for options in ["--amend", "--amend --no-edit", "--am", "--fixup=HEAD", "--squash HEAD",
                        "-c HEAD", "-C HEAD", "--reuse-message=HEAD", "--reedit-message HEAD",
                        "--allow-empty-message", "-e", "--edit", "--dry-run", "-h", "-ae"]:
            with self.subTest(options=options):
                self.assertIsNone(self.check(f"git commit {options} -m '{TITLE}' -m '{BODY}'"))

    def test_a_file_the_command_writes_before_the_commit_is_not_read(self):
        # The file on disk still holds the old message, and the command rewrites it first.
        self.write("m.txt", LAST)
        self.write("other.txt", "A new title\n")
        os.mkdir(os.path.join(self.repo, "drafts"))
        self.write("m.txt", "A new title\n", os.path.join(self.repo, "drafts"))
        for command in [
            "cat > m.txt <<'EOF'\nA new title\nEOF\ngit commit -F m.txt",
            "cat <<'EOF' > m.txt && git commit -F m.txt\nA new title\nEOF",
            "printf '%s\\n' x >> m.txt && git commit -F m.txt",
            "printf 'x\\n' >m.txt; git commit -F m.txt",
            "tee m.txt <<'EOF' && git commit -F m.txt\nA new title\nEOF",
            "echo x | tee -a log.txt m.txt && git commit -F m.txt",
            "cp other.txt m.txt && git commit -F m.txt",
            "mv -f other.txt m.txt && git commit -F m.txt",
            "install -m 644 other.txt m.txt && git commit -F m.txt",
            "cp drafts/m.txt . && git commit -F m.txt",
            "cp -t . drafts/m.txt && git commit -F m.txt",
            "command cp other.txt ./m.txt && git commit -F m.txt",
            'printf x > "$out" && git commit -F m.txt',
            "bash -c 'printf x > m.txt' && git commit -F m.txt",
        ]:
            with self.subTest(command=command):
                self.assertIsNone(self.check(command))

    def test_a_file_the_command_only_reads_before_the_commit_is_checked(self):
        self.write("m.txt", LAST)
        for command in [
            "head -1 m.txt && git commit -F m.txt",
            "cat m.txt && git commit -F m.txt",
            "wc -l m.txt; grep -n x m.txt; ls -la m.txt && git commit -F m.txt",
            "cat <<'EOF'\nthe message is in m.txt\nEOF\ngit commit -F m.txt",
            "cp m.txt backup.txt && git commit -F m.txt",
            "tee log.txt < m.txt && git commit -F m.txt",
            "git commit -F m.txt && rm m.txt",
        ]:
            with self.subTest(command=command):
                self.assert_denied(command)

    def test_the_writes_rules(self):
        def writes(text):
            return [path for words in message_guard.simple_commands(text)
                    for path in message_guard.written(words)]
        self.assertEqual(writes("cat a > b 2>> c"), ["b", "c"])
        self.assertEqual(writes("cat <<< x > b"), ["b"])
        self.assertEqual(writes("tee -a a b"), ["a", "b"])
        self.assertEqual(writes("cp -r a b c/"), ["a", "b"])
        self.assertEqual(writes("cp --target-directory=d a b"), ["a", "b"])
        self.assertEqual(writes("X=1 sudo mv a b"), ["b"])
        self.assertEqual(writes("head -1 a; cat a b; grep x a"), [])

    def test_a_message_from_a_variable_or_a_substitution_is_allowed(self):
        self.write("cm.txt", LAST)
        for command in ['git commit -m "$msg"', 'git commit -F "$file"', "git commit -F $f",
                        'git commit -m "$(cat cm.txt)"', "git commit -m `cat cm.txt`",
                        f"git commit -F - <<EOF\n{TITLE}\n\n$BODY\nEOF",
                        f"git commit -F - <<< \"{TITLE}$x\"",
                        "cat cm.txt | git commit -F -", "git commit -F -", "git commit",
                        "git commit -F missing.txt", "git commit -F .",
                        "git commit -m ''", f"git commit -m '{TITLE}' -F cm.txt",
                        f"git commit --no-such-option -m '{TITLE}' -m '{BODY}'"]:
            with self.subTest(command=command):
                self.assertIsNone(self.check(command))

    def test_a_backtick_in_a_quoted_message_is_text(self):
        make_repo(os.path.join(self.root, "ticks"), "Read `git -C` folders\n")
        self.assert_denied("git commit -m 'Read `git -C` folders'", os.path.join(self.root, "ticks"))

    def test_no_repository_is_allowed(self):
        bare = os.path.join(self.root, "plain")
        os.mkdir(bare)
        self.assertIsNone(self.check(f"git commit -m '{TITLE}' -m '{BODY}'", bare))

    def test_a_repository_with_no_commit_yet_is_allowed(self):
        empty = make_repo(os.path.join(self.root, "empty"))
        self.assertIsNone(self.check(f"git commit -m '{TITLE}' -m '{BODY}'", empty))

    def test_repeat_message_ok_lets_it_through(self):
        same = f"git commit -m '{TITLE}' -m '{BODY}'"
        self.assertIsNone(self.check(f"REPEAT_MESSAGE_OK=1 {same}"))
        self.assertIsNone(self.check(f"X=1 REPEAT_MESSAGE_OK=1 {same}"))
        self.assertIsNone(self.check(f"cd {self.repo} && REPEAT_MESSAGE_OK=1 {same}"))
        self.assert_denied(f"REPEAT_MESSAGE_OK=0 {same}")

    def test_git_c_and_cd_resolve_against_that_repository(self):
        other = make_repo(os.path.join(self.repo, "other", "repo"), "Count the words\n")
        self.assert_denied("git -C other/repo commit -m 'Count the words'")
        self.assert_denied("cd other/repo && git commit -m 'Count the words'")
        self.assert_denied("git -C other -C repo commit -m 'Count the words'")
        self.assert_denied(f"git --no-pager -c core.pager=cat -C {other} commit -m 'Count the words'",
                           cwd=self.root)
        # The repository the commit runs in is the one compared with.
        self.assertIsNone(self.check(f"git -C other/repo commit -m '{TITLE}' -m '{BODY}'"))
        self.assertIsNone(self.check("git commit -m 'Count the words'"))
        # A folder the text does not settle is not checked.
        self.assertIsNone(self.check('cd "$dir" && git commit -m \'Count the words\''))
        self.assertIsNone(self.check("git -C $dir commit -m 'Count the words'"))
        self.assertIsNone(self.check("git -C no/such commit -m 'Count the words'"))

    def test_a_commit_in_a_shell_string_or_behind_a_wrapper_is_read(self):
        same = f"git commit -m '{TITLE}' -m '{BODY}'"
        self.assert_denied(f'bash -c "{same}"')
        self.assert_denied(f"if true; then command {same}; fi")
        self.assert_denied(f"env X=1 {same}")
        self.assertIsNone(self.check(f"env REPEAT_MESSAGE_OK=1 {same}"))

    def test_an_earlier_part_that_may_move_head_stops_the_check(self):
        same = f"git commit -m '{TITLE}' -m '{BODY}'"
        for before in ["git commit -m 'Another one'", "git switch -c other", "git reset HEAD~",
                       "git checkout main", "git pull", "git stash"]:
            with self.subTest(before=before):
                self.assertIsNone(self.check(f"{before} && {same}"))
        self.assert_denied(f"git add -A && git status && {same}")

    def test_a_repository_set_by_a_variable_is_not_checked(self):
        same = f"git commit -m '{TITLE}' -m '{BODY}'"
        self.assertIsNone(self.check(f"GIT_DIR=elsewhere/.git {same}"))
        self.assertIsNone(self.check(f"export GIT_WORK_TREE=/x; {same}"))
        with mock.patch.dict(os.environ, {"GIT_DIR": "/nowhere/.git"}):
            self.assertIsNone(self.check(same))

    def test_a_quote_that_does_not_close_is_allowed(self):
        self.assertIsNone(self.check(f"git commit -m '{TITLE}"))

    def test_a_command_with_no_commit_starts_no_process(self):
        with mock.patch.object(message_guard.subprocess, "run") as run:
            for command in ["git status", "git log -1 --format=%B", "ls -la", "",
                            "gh pr view 16", "uv run pytest -q", "echo commit this",
                            "grep -n commit notes.md", "git commit -m \"$msg\"",
                            f"git commit --amend -m '{TITLE}'", "git commit"]:
                with self.subTest(command=command):
                    self.assertIsNone(self.check(command))
            run.assert_not_called()

    def test_git_that_cannot_run_is_no_objection(self):
        same = f"git commit -m '{TITLE}' -m '{BODY}'"
        for error in [OSError("no git"), subprocess.TimeoutExpired("git", 5)]:
            with self.subTest(error=error):
                with mock.patch.object(message_guard.subprocess, "run", side_effect=error):
                    self.assertIsNone(self.check(same))

    def test_the_message_rules(self):
        source = message_guard.message_source
        self.assertEqual(source(["-m", "a", "-m", "b"]), ("messages", ["a", "b"]))
        self.assertEqual(source(["-qam", "a"]), ("messages", ["a"]))
        self.assertEqual(source(["-ma"]), ("messages", ["a"]))
        self.assertEqual(source(["-m", "-a"]), ("messages", ["-a"]))
        self.assertEqual(source(["-F", "x", "--file", "y"]), ("file", "y"))
        self.assertEqual(source(["-uno", "-S", "-m", "a", "--", "-m"]), ("messages", ["a"]))
        self.assertEqual(source(["--gpg-sign", "--trailer", "k: v", "-m", "a"]), ("messages", ["a"]))
        self.assertIsNone(source([]))
        self.assertIsNone(source(["-m"]))
        self.assertIsNone(source(["-x", "-m", "a"]))
        self.assertIsNone(source(["--a", "-m", "a"]))
        cleaned = message_guard.cleaned
        self.assertEqual(cleaned("\n\ntitle  \r\n\r\n\r\nbody\t\n\n"), "title\n\nbody")
        self.assertEqual(cleaned(" \n\n"), "")


if __name__ == "__main__":
    unittest.main()
