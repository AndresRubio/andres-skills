#!/usr/bin/env python3
"""Deny a `git commit` whose message is the same as the last commit's.

PreToolUse on Bash. A command that writes a message file and then runs
`git commit -F` on it does nothing when another hook refuses it. Run again without the
write, the commit takes the file's old text, so the new commit carries the previous
commit's message. For each `git commit` the command runs, the hook works out the
message it would use and compares it with HEAD's, read with `git log -1`. The same
message is denied.

The message is the `-m` and `--message` values in order, joined by a blank line as git
joins them, or the `-F` or `--file` file read from disk in the commit's folder, or the
heredoc or here-string fed to `-F -`. Both sides are compared the way git cleans a
message it does not edit: trailing spaces and blank lines go, a run of blank lines is
one, and CRLF reads as LF. The folder follows `cd`, `pushd` and `git -C`.

Most doubt lets the commit through, since a false refusal stops work and the repeat is
rare. A commit is not checked when it repeats or edits a message on purpose (`--amend`,
`--fixup`, `--squash`, `-c`, `-C`, `--reuse-message`, `--reedit-message`, `-e`), when it
may make no commit (`--dry-run`, `--allow-empty-message`, `-h`), when an option is one
this hook does not know, when its message comes from a variable, a `$(...)`, a pipe, a
file that cannot be read, or a file an earlier part of the command writes, when no
message is given and the editor would open, when the folder or the repository cannot be
read from the text (`GIT_DIR`, `GIT_WORK_TREE`), when an earlier part of the command
may move HEAD (another commit, a checkout, a reset and so on), and when git fails or the
repository has no commit yet. A command with no `commit` in it starts no process.

An earlier part writes the file when it names the file as the target of `>` or `>>`,
as an argument of `tee`, or as the last argument of `cp`, `mv` or `install`, or names a
folder there that the file is copied into. Only the file's name is compared, and a
target the text does not spell out, such as `"$out"`, counts as that file. Any other
mention reads the file (`head -1 m.txt`, `cat m.txt`, a heredoc body that names it), so
the check still runs.

REPEAT_MESSAGE_OK=1 in front of the command, or in front of the commit itself, lets it
through: the repeat is meant.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shell_words import ASSIGNMENT, BEFORE, SHELLS, WRAPPERS, moved, simple_commands  # noqa: E402

ALLOWED = re.compile(r"^\s*(?:[A-Za-z_]\w*=\S*\s+)*REPEAT_MESSAGE_OK=1(?:\s|$)")
# A command with none of this in it runs no commit.
MENTIONS = re.compile(r"(?<![\w-])commit(?![\w-])")
# A word that may hold a variable or a `$(...)`. A backtick left in a word was quoted,
# since the shell words turn a real substitution into `$(...)`.
EXPANDS = re.compile(r"\$")
# What the shell replaces in a heredoc whose delimiter is not quoted.
EXPANDS_IN_BODY = re.compile(r"[$`\\]")
# A path the text does not spell out.
UNSPELLED = re.compile(r"[$*?\[]")
# Commands that write each file named, and those that write the last one named.
WRITES_EACH = {"tee"}
WRITES_LAST = {"cp", "mv", "install"}
# Variables that move the repository away from the folder.
REPO_VARIABLES = {"GIT_DIR", "GIT_WORK_TREE"}

# git's options before the subcommand that take the next word as their value.
GIT_VALUED = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
              "--config-env", "--exec-path", "--list-cmds"}
# Subcommands that may leave HEAD on another commit, so a later commit's last message
# is not the one on disk now.
MOVES_HEAD = {"commit", "checkout", "switch", "reset", "rebase", "merge", "pull",
              "cherry-pick", "revert", "am", "stash", "bisect", "symbolic-ref", "update-ref",
              "branch", "worktree", "filter-branch", "replace"}

# `git commit` long options: True when the value is the next word or after `=`, None
# when it may only follow `=`, False when it takes none.
LONG = {
    "message": True, "file": True, "reuse-message": True, "reedit-message": True,
    "fixup": True, "squash": True, "author": True, "date": True, "template": True,
    "cleanup": True, "trailer": True, "pathspec-from-file": True,
    "gpg-sign": None, "untracked-files": None,
    "all": False, "patch": False, "reset-author": False, "short": False, "branch": False,
    "porcelain": False, "long": False, "null": False, "signoff": False,
    "no-signoff": False, "no-verify": False, "verify": False, "allow-empty": False,
    "allow-empty-message": False, "edit": False, "no-edit": False, "amend": False,
    "no-amend": False, "no-post-rewrite": False, "include": False, "only": False,
    "pathspec-file-nul": False, "verbose": False, "quiet": False, "dry-run": False,
    "status": False, "no-status": False, "no-gpg-sign": False, "interactive": False,
    "ahead-behind": False, "no-ahead-behind": False, "help": False,
}
# Short options with a value: the rest of the word, else the next word.
SHORT_VALUED = set("mFcCt")
# Short options whose value can only be glued on.
SHORT_GLUED = set("uS")
SHORT_FLAGS = set("apsnevqoizh")
# Options that repeat or edit a message on purpose, or may make no commit.
ON_PURPOSE = {"amend", "fixup", "squash", "reuse-message", "reedit-message",
              "allow-empty-message", "dry-run", "edit", "help", "c", "C", "e", "h"}
# What the hook answers when check() gives a reason.
DECISION = "deny"


def _long_name(word):
    """(name, value or None) for a `--word`, or None when git would not know it. git
    takes a unique prefix of a long option."""
    name, has_value, value = word[2:].partition("=")
    if name in LONG:
        return name, value if has_value else None
    found = [option for option in LONG if option.startswith(name)]
    if len(found) != 1:
        return None
    return found[0], value if has_value else None


def message_source(args):
    """Where `git commit args` takes its message from: ("messages", [values]),
    ("file", path), or None when it has none, repeats one on purpose, or the options
    cannot be read."""
    messages, files = [], []
    i = 0
    while i < len(args):
        word = args[i]
        i += 1
        if word == "--":
            break
        if word.startswith("--"):
            found = _long_name(word)
            if found is None:
                return None
            name, value = found
            if name in ON_PURPOSE:
                return None
            if LONG[name] is True and value is None:
                if i >= len(args):
                    return None
                value = args[i]
                i += 1
            if name == "message":
                messages.append(value)
            elif name == "file":
                files.append(value)
        elif word.startswith("-") and word != "-":
            letters = word[1:]
            while letters:
                letter, letters = letters[0], letters[1:]
                if letter in ON_PURPOSE:
                    return None
                if letter in SHORT_GLUED:
                    break
                if letter in SHORT_VALUED:
                    if not letters:
                        if i >= len(args):
                            return None
                        letters = args[i]
                        i += 1
                    if letter == "m":
                        messages.append(letters)
                    elif letter == "F":
                        files.append(letters)
                    break
                if letter not in SHORT_FLAGS:
                    return None
    if messages and not files:
        return "messages", messages
    if files and not messages:
        return "file", files[-1]
    return None


def cleaned(text):
    """The message as git keeps one it does not edit."""
    lines = []
    for line in text.replace("\r\n", "\n").split("\n"):
        line = line.rstrip()
        if line or (lines and lines[-1]):
            lines.append(line)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def written(words):
    """The paths one simple command writes, as the text names them."""
    paths = list(words.redirects)
    rest = list(words)
    # The words a redirect or a here-string took are no arguments.
    for taken in words.redirects + words.inputs + words.herestrings:
        if taken in rest:
            rest.remove(taken)
    while rest and (ASSIGNMENT.match(rest[0]) or rest[0] in BEFORE):
        rest = rest[1:]
    if rest and os.path.basename(rest[0]) in WRAPPERS:
        at = next((i for i, word in enumerate(rest)
                   if os.path.basename(word) in WRITES_EACH | WRITES_LAST), None)
        rest = rest[at:] if at is not None else []
    if not rest:
        return paths
    head = os.path.basename(rest[0])
    if head not in WRITES_EACH | WRITES_LAST:
        return paths
    args, folder = [], None
    words_left = iter(rest[1:])
    for word in words_left:
        if word in ("-t", "--target-directory"):
            folder = next(words_left, "")
        elif word.startswith("--target-directory="):
            folder = word.split("=", 1)[1]
        elif not word.startswith("-") or word == "-":
            args.append(word)
    if head in WRITES_EACH:
        return paths + args
    if folder is None and args:
        target = args.pop()
        if not (target.endswith("/") or os.path.basename(target) in ("", ".", "..")):
            return paths + [target]
    # Copied into a folder: each file keeps its name.
    return paths + [os.path.basename(arg) for arg in args]


def message_text(source, folder, words, writes):
    """The text the commit would use, or None when it cannot be read from here.
    `writes` holds the paths the parts of the command before it write."""
    kind, value = source
    if kind == "messages":
        if any(EXPANDS.search(message) for message in value):
            return None
        return "\n\n".join(value)
    if value == "-":
        if len(words.heredocs) + len(words.herestrings) != 1:
            # No stdin the text shows, or more than one.
            return None
        if words.herestrings:
            fed = words.herestrings[0]
            return None if EXPANDS.search(fed) else fed
        fed = words.heredocs[0]
        if not words.literal_heredocs and EXPANDS_IN_BODY.search(fed):
            return None
        return fed
    if EXPANDS.search(value) or re.search(r"[*?\[]", value):
        return None
    name = os.path.basename(value)
    if not name or any(os.path.basename(path) == name or UNSPELLED.search(path)
                       for path in writes):
        # The command may write the file before the commit reads it.
        return None
    path = os.path.join(folder, os.path.expanduser(value))
    try:
        with open(path, "rb") as f:
            return f.read(1_000_000).decode("utf-8", errors="replace")
    except OSError:
        return None


def last_commit(folder, repo_options):
    """(short hash, message) of HEAD in `folder`, or None when git cannot say."""
    try:
        done = subprocess.run(
            ["git", "-C", folder, *repo_options, "log", "-1", "--no-show-signature",
             "--format=%h%n%B"],
            capture_output=True, encoding="utf-8", errors="replace", timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if done.returncode != 0:
        return None
    short, _, message = done.stdout.partition("\n")
    return (short.strip(), message) if short.strip() else None


def git_call(words, cwd):
    """(subcommand, its args, folder, repo options) for the words after `git`, where
    folder is None when the text does not say which."""
    folder = cwd
    repo_options = []
    i = 0
    while i < len(words) and words[i].startswith("-"):
        word = words[i]
        name, has_value, value = word.partition("=")
        if name in GIT_VALUED and not has_value:
            value = words[i + 1] if i + 1 < len(words) else ""
            i += 2
        else:
            i += 1
        if name == "-C":
            folder = moved(folder, [value]) if value else None
        elif name in ("--git-dir", "--work-tree"):
            if EXPANDS.search(value):
                folder = None
            repo_options.append(f"{name}={value}")
    if i >= len(words):
        return None, [], folder, repo_options
    return words[i], words[i + 1:], folder, repo_options


def refusal(short, message):
    title = message.split("\n", 1)[0]
    return (
        f"This commit was stopped because its message is the same as the last commit's "
        f"(`{short} {title}`). That usually means a message file was written in a "
        f"command that was refused, so it was never rewritten and still holds the old "
        f"message. Write the message again and commit. If the repeat is meant, run the "
        f"command again with REPEAT_MESSAGE_OK=1 in front."
    )


class _Walk:
    """What the command did before the part being read."""

    def __init__(self):
        self.writes = []
        self.head_moved = False


def _reason(command, cwd, walk, exported):
    try:
        commands = simple_commands(command)
    except ValueError:
        return None
    for words in commands:
        why = _one(words, cwd, walk, exported)
        if isinstance(why, str):
            return why
        if why is not None:
            cwd = why[0]
        walk.writes.extend(written(words))
    return None


def _one(words, cwd, walk, exported):
    """A reason string, or (new cwd,) after a `cd`, or None."""
    env = dict(exported)
    all_words = words
    while words and (ASSIGNMENT.match(words[0]) or words[0] in BEFORE):
        found = ASSIGNMENT.match(words[0])
        if found:
            env[found.group(1)] = found.group(2)
        words = words[1:]
    if not words:
        exported.update(env)
        return None
    head = os.path.basename(words[0])
    if head in WRAPPERS:
        runs = SHELLS | {"git", "eval"}
        at = next((i for i, word in enumerate(words) if os.path.basename(word) in runs), None)
        if at is None:
            return None
        for word in words[:at]:
            found = ASSIGNMENT.match(word)
            if found:
                env[found.group(1)] = found.group(2)
        words = words[at:]
        head = os.path.basename(words[0])
    if head == "export":
        for word in words[1:]:
            found = ASSIGNMENT.match(word)
            if found:
                exported[found.group(1)] = found.group(2)
        return None
    if head in ("cd", "pushd"):
        return (moved(cwd, words[1:]),)
    if head == "popd":
        return (None,)
    if head in SHELLS or head == "eval":
        if head == "eval":
            script = " ".join(words[1:])
        else:
            script = next((after for flag, after in zip(words[1:], words[2:])
                           if re.fullmatch(r"-[a-zA-Z]*c", flag)), None)
            script = script or "\n".join(all_words.heredocs)
        if not script or env.get("REPEAT_MESSAGE_OK") == "1":
            return None
        return _reason(script, cwd, walk, dict(env))
    if head != "git":
        return None
    sub, args, folder, repo_options = git_call(words[1:], cwd)
    if sub != "commit":
        if sub in MOVES_HEAD:
            walk.head_moved = True
        return None
    was_moved = walk.head_moved
    walk.head_moved = True
    if was_moved or folder is None or env.get("REPEAT_MESSAGE_OK") == "1":
        return None
    if REPO_VARIABLES & set(env) or REPO_VARIABLES & set(os.environ):
        return None
    source = message_source(args)
    if source is None:
        return None
    text = message_text(source, folder, all_words, walk.writes)
    if text is None or not cleaned(text):
        return None
    head_commit = last_commit(folder, repo_options)
    if head_commit is None:
        return None
    short, message = head_commit
    if cleaned(message) != cleaned(text):
        return None
    return refusal(short, cleaned(message))


def reason(command, cwd):
    """Why this command is denied, else None."""
    if not MENTIONS.search(command) or ALLOWED.search(command):
        return None
    return _reason(command, cwd, _Walk(), {})


def check(payload):
    """Why this tool call is denied, else None."""
    command = (payload.get("tool_input") or {}).get("command") or ""
    return reason(command, payload.get("cwd") or os.getcwd())


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
