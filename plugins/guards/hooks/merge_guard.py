#!/usr/bin/env python3
"""Deny `gh pr merge` when the pull request does not merge into the default branch.

PreToolUse on Bash. A pull request opened on top of another one keeps that branch as
its base. Merging it lands the work on the other branch, and GitHub reports "merged"
all the same. For each `gh pr merge` the command would run, the hook asks GitHub for
the pull request's base and for the repository's default branch, and denies the merge
when they differ or when it cannot read either.

Only a `gh` in command position counts: after `&&`, `;`, a pipe or a newline, inside
`$(...)`, in the string a `bash -c` or an `eval` runs, or behind a wrapper such as
`time`, `timeout 60`, `env` or `xargs`. A grep for the words, or a message that quotes them,
is no merge and asks GitHub nothing. The pull request is the one the command names (a
number, a URL or a branch, with -R, --repo or GH_REPO), else the one of the branch
checked out where the command runs, which a literal `cd` before it moves. When the
folder cannot be read from the text, as after `cd "$dir"`, and the command names no
URL or repository, the merge is denied. A heredoc is text, and only one fed to a shell
is read as commands.

MERGE_BASE_OK=1 in front of the command, or in front of the merge itself, lets it
through: a stacked pull request the user wants merged into its parent.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shell_words import ASSIGNMENT, BEFORE, SHELLS, WRAPPERS, moved, simple_commands  # noqa: E402

ALLOWED = re.compile(r"^\s*(?:[A-Za-z_]\w*=\S*\s+)*MERGE_BASE_OK=1(?:\s|$)")
# What the words look like in a text the shell words could not be read from.
LOOSE = re.compile(r"(?<![\w-])gh\s[^\n;|&]*?\bpr\s[^\n;|&]*?\bmerge(?![\w-])")
PR_URL = re.compile(r"https?://([^/]+)/([^/]+/[^/]+)/pull/(\d+)")
# Options of `gh pr merge` that take a value, which is then no pull request.
VALUED = {"-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject",
          "--match-head-commit", "-A", "--author-email"}
# What the hook answers when check() gives a reason.
DECISION = "deny"


def merge_target(words):
    """(selector, repo, wants_help) when the words after `gh` are a `pr merge`, else
    None. gh takes -R before the subcommand as well as after it."""
    selector = repo = None
    wants_help = False
    expected = ["pr", "merge"]
    skip = False
    for i, word in enumerate(words):
        if skip:
            skip = False
        elif word in ("-h", "--help"):
            wants_help = True
        elif word in ("-R", "--repo"):
            repo = words[i + 1] if i + 1 < len(words) else None
            skip = True
        elif word.startswith("--repo="):
            repo = word.split("=", 1)[1]
        elif word in VALUED:
            skip = True
        elif word.startswith("-"):
            continue
        elif expected:
            if word != expected.pop(0):
                return None
        elif selector is None:
            selector = word
    return None if expected else (selector, repo, wants_help)


def gh(args, cwd):
    """(stdout, None) or (None, why it failed)."""
    try:
        done = subprocess.run(["gh", *args], cwd=cwd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, str(error)
    if done.returncode != 0:
        return None, (done.stderr.strip() or f"gh exited {done.returncode}").splitlines()[-1]
    return done.stdout, None


def bases(selector, repo, cwd):
    """(number, base, default, None) for the pull request, or (.., why) when GitHub
    could not be read."""
    args = ["pr", "view", *([selector] if selector else []), *(["--repo", repo] if repo else []),
            "--json", "baseRefName,url"]
    out, why = gh(args, cwd)
    if out is None:
        return None, None, None, why
    try:
        pr = json.loads(out)
        base = pr["baseRefName"]
        host, name, number = PR_URL.search(pr["url"]).groups()
    except (ValueError, KeyError, AttributeError, TypeError):
        return None, None, None, "gh pr view gave no base branch"
    full = name if host == "github.com" else f"{host}/{name}"
    out, why = gh(["repo", "view", full, "--json", "defaultBranchRef"], cwd)
    if out is None:
        return number, base, None, why
    try:
        default = json.loads(out)["defaultBranchRef"]["name"]
    except (ValueError, KeyError, TypeError):
        return number, base, None, "gh repo view gave no default branch"
    return number, base, default, None


def refusal(selector, repo, cwd, session_cwd):
    """Why one merge is denied, else None. `cwd` is None when the text does not say
    where the merge runs."""
    if repo and "$" in repo:
        return (
            "Could not tell which repository this merge names, since the text sets it "
            "from a variable or a command, so the merge was stopped. Name the pull "
            "request by its URL, or run the merge again with MERGE_BASE_OK=1 in front if "
            "its base is the one you mean."
        )
    if cwd is None and not (selector and (repo or PR_URL.search(selector))):
        return (
            "Could not tell which folder this merge runs in, so the pull request it "
            "would merge is unknown and the merge was stopped. Name the pull request by "
            "its URL, or by number with --repo, or run the merge again with "
            "MERGE_BASE_OK=1 in front if its base is the one you mean."
        )
    number, base, default, why = bases(selector, repo, cwd or session_cwd)
    named = f"pull request {number}" if number else "this pull request"
    if why is not None:
        return (
            f"Could not check which branch {named} merges into ({why}), so the merge "
            f"was stopped. Check it with `gh pr view --json baseRefName`, then run the "
            f"merge again with MERGE_BASE_OK=1 in front if the base is the one you mean."
        )
    if base != default:
        return (
            f"Pull request {number} merges into `{base}`, and the repository's default "
            f"branch is `{default}`. Merging it lands the work on `{base}` only. To "
            f"merge it into `{default}`, change its base first: `gh pr edit {number} "
            f"--base {default}`. If the user wants it merged into `{base}`, run the "
            f"merge again with MERGE_BASE_OK=1 in front."
        )
    return None


def reason(command, session_cwd, exported=None):
    """Why this command is denied, else None. `exported` holds the variables an
    `export` set earlier in the command."""
    if ALLOWED.search(command):
        return None
    try:
        commands = simple_commands(command)
    except ValueError:
        if LOOSE.search(command):
            return (
                "This command has a quote that does not close and may run `gh pr merge`, "
                "so it was stopped. Fix the quoting and run it again."
            )
        return None
    exported = dict(exported or {})
    cwd = session_cwd
    for words in commands:
        heredocs = words.heredocs
        env = dict(exported)
        while words and (ASSIGNMENT.match(words[0]) or words[0] in BEFORE):
            found = ASSIGNMENT.match(words[0])
            if found:
                env[found.group(1)] = found.group(2)
            words = words[1:]
        if not words:
            # Variables set on a line of their own stay set for what follows. The same
            # holds for `X=$(...) gh ...`, which the reader hands over in pieces.
            exported.update(env)
            continue
        head = os.path.basename(words[0])
        if head in WRAPPERS:
            # `timeout 60 gh ...`, `env X=1 gh ...`, `xargs -n1 sh -c '...'`: the command
            # it runs starts at the first gh, shell or eval among its words, and a
            # variable set on the way is set for that command.
            runs = SHELLS | {"gh", "eval"}
            at = next((i for i, word in enumerate(words) if os.path.basename(word) in runs), None)
            if at is None:
                continue
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
        elif head in ("cd", "pushd"):
            cwd = moved(cwd, words[1:])
        elif head in SHELLS or head == "eval":
            # The string after -c, or the words eval joins, are a command of their own,
            # run where this one is.
            if head == "eval":
                script = " ".join(words[1:])
            else:
                script = next((after for flag, after in zip(words[1:], words[2:])
                               if re.fullmatch(r"-[a-zA-Z]*c", flag)), None)
                # A shell with no -c reads its script from a heredoc.
                script = script or "\n".join(heredocs)
            if not script or env.get("MERGE_BASE_OK") == "1":
                continue
            if cwd is None:
                if LOOSE.search(script):
                    return refusal(None, None, None, session_cwd)
                continue
            why = reason(script, cwd, env)
            if why is not None:
                return why
        elif head == "gh":
            target = merge_target(words[1:])
            if target is None or target[2] or env.get("MERGE_BASE_OK") == "1":
                continue
            selector, repo, _ = target
            why = refusal(selector, repo or env.get("GH_REPO"), cwd, session_cwd)
            if why is not None:
                return why
    return None


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
