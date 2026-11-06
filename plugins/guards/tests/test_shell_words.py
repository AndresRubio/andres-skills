"""Tests for shell_words.py. Run: python3 plugins/guards/tests/test_shell_words.py"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
from shell_words import simple_commands  # noqa: E402

CASES = {
    "ls -la": [["ls", "-la"]],
    "cd x && make; echo done": [["cd", "x"], ["make"], ["echo", "done"]],
    "a || b | c & d": [["a"], ["b"], ["c"], ["d"]],
    "a\nb": [["a"], ["b"]],
    "a \\\n b": [["a", "b"]],
    "ls;cd /tmp;ls": [["ls"], ["cd", "/tmp"], ["ls"]],
    "(cd /tmp; ls)": [["cd", "/tmp"], ["ls"]],
    # A quoted string is one word, whatever it holds.
    "git log --grep 'a; b && c'": [["git", "log", "--grep", "a; b && c"]],
    'say "x|y # z" 7': [["say", "x|y # z", "7"]],
    '--body="fix it" 7': [["--body=fix it", "7"]],
    "echo 'it'\\''s'": [["echo", "it's"]],
    'echo "a \\"b\\" c"': [["echo", 'a "b" c']],
    "\\gh pr list": [["gh", "pr", "list"]],
    "echo ''": [["echo", ""]],
    # A comment ends at its line, and a # inside a word is no comment.
    "cd wt  # the worktree\ngh pr list": [["cd", "wt"], ["gh", "pr", "list"]],
    "echo issue#3; ls": [["echo", "issue#3"], ["ls"]],
    "echo $# ; ls": [["echo", "$#"], ["ls"]],
    "# only a comment": [],
    # Redirections end a word.
    "run >/tmp/y 2>&1": [["run", "/tmp/y", "2"], ["1"]],
    "sort <in.txt": [["sort", "in.txt"]],
    # Substitutions are commands, and leave a hole where their output goes.
    "echo $(date)": [["echo", "$(...)"], ["date"]],
    "cd $(pwd)/tmp && ls": [["cd", "$(...)"], ["pwd"], ["$(...)/tmp"], ["ls"]],
    "echo `date` now": [["echo", "$(...)"], ["date"], ["now"]],
    "echo 'a`b'; echo `date`": [["echo", "a`b"], ["echo", "$(...)"], ["date"]],
    "x=`pwd`/tmp": [["x=$(...)"], ["pwd"], ["$(...)/tmp"]],
    'echo "at $(date +%s) now"': [["date", "+%s"], ["echo", "at $(...) now"]],
    'echo "in `pwd`"': [["pwd"], ["echo", "in $(...)"]],
    "echo '$(date)'": [["echo", "$(date)"]],
    'echo "$(echo "$(date)")"': [["date"], ["echo", "$(...)"], ["echo", "$(...)"]],
}


HEREDOCS = {
    # A body is text on the command it feeds, and the next line is a command again.
    "cat <<EOF > notes.md\nit's here; not a command\nEOF\nls": (
        [["cat", "notes.md"], ["ls"]], [["it's here; not a command"], []]),
    "cat <<'EOF' | grep x\na\nb\nEOF\n": ([["cat"], ["grep", "x"]], [["a\nb"], []]),
    "cat <<-EOF\n\tindented\n\tEOF\necho done": ([["cat"], ["echo", "done"]], [["\tindented"], []]),
    'cat <<"END"; echo one\nbody\nEND\necho two': (
        [["cat"], ["echo", "one"], ["echo", "two"]], [["body"], [], []]),
    "python3 - <<PY\nprint('never closed')": ([["python3", "-"]], [["print('never closed')"]]),
    "cat <<A <<B\none\nA\ntwo\nB\n": ([["cat"]], [["one", "two"]]),
    "cat <<< 'a here string'": ([["cat", "a here string"]], [[]]),
}


class ShellWordsTest(unittest.TestCase):
    def test_a_heredoc_body_is_text_on_its_command(self):
        for text, (commands, bodies) in HEREDOCS.items():
            with self.subTest(text=text):
                found = simple_commands(text)
                self.assertEqual(found, commands)
                self.assertEqual([words.heredocs for words in found], bodies)

    def test_deep_nesting_is_an_error_and_many_backticks_are_quick(self):
        with self.assertRaises(ValueError):
            simple_commands('echo ' + '"$(' * 3000)
        started = time.monotonic()
        self.assertEqual(len(simple_commands("echo " + "`x` " * 50_000)), 100_000)
        self.assertLess(time.monotonic() - started, 2)

    def test_commands_and_words(self):
        for text, expected in CASES.items():
            with self.subTest(text=text):
                self.assertEqual(simple_commands(text), expected)

    def test_a_quote_that_does_not_close_is_an_error(self):
        for text in ["echo 'open", 'echo "open', 'echo "$(date"', "echo \"`date\""]:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    simple_commands(text)


if __name__ == "__main__":
    unittest.main()
