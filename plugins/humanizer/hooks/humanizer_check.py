#!/usr/bin/env python3
"""Flag AI-writing tells in prose Claude writes (humanizer skill, always on).

Modes, picked by the first argument:
  prompt  UserPromptSubmit: inject a one-line reminder of the writing rules.
  post    PostToolUse on Write|Edit|MultiEdit: check the prose just written to a
          .md/.txt/.rst file and feed any tells back so Claude fixes them.
  commit  PreToolUse on Bash: check the message a `git commit` carries (-m, -F, a
          heredoc or here-string feeding it) and the title and body of a `gh pr
          create|edit` (-t, -b, -F, --body-file), and deny the call until the
          strong tells are gone. Only that text is read: the words those options
          take, every heredoc and here-string body in the command, and the files
          the options name (relative to `git -C`, a leading `cd`, or the hook's
          cwd; a file the command itself writes is skipped, its body having been
          read). The command's other words, flags and paths are not read, so a
          bare `--` cannot count as a dash; a command that cannot be scanned (an
          unclosed quote) is read whole, flags aside. A `git commit` is also
          denied while a line it adds to a .md/.txt/.rst file has any tell,
          whatever tool wrote it (a Bash heredoc never reaches the post hook); text
          already in HEAD never blocks. The files are what the commit would take:
          the index, the working tree for -a or a named path, and whatever a `git
          add` earlier in the command is about to stage, in the repo a `cd` or
          `git -C` leads to. A folder given as a variable cannot be followed, and
          the check then passes. Prefix the command with HUMANIZER_OK=1 to pass a
          message or added lines whose tells are deliberate (a quote).
  stop    Stop: check the closing message of the turn, with code stripped as in
          the other modes, and show any tells to the owner as a systemMessage.
          Claude never sees it and the turn ends as usual. The owner chose this on
          2026-11-03 over a rewrite, which costs a turn and leaves the first
          version on screen.
  file    `humanizer_check.py file PATH`: check one file directly. Prints the
          tells and exits 1 when there are any, exits 0 when the text is clean.

Rules come from this plugin's skills/humanizer/SKILL.md and the "Writing like a
person" section of ~/.claude/CLAUDE.md. English and Spanish.
"""
import codecs
import json
import os
import re
import subprocess
import sys

PROSE_EXT = {".md", ".markdown", ".mdx", ".txt", ".rst"}
# Files that discuss the tells instead of using them.
SKIP_PATHS = (
    os.path.expanduser("~/.claude/skills/"),
    os.path.expanduser("~/.claude/CLAUDE.md"),
    os.path.expanduser("~/.claude/hooks/"),
)
MAX_HITS = 8

REMINDER = (
    "Writing rules (humanizer, always on): lead with the answer; plain sentences; "
    "no em/en dashes in prose; no 'not X but Y' / 'no es X, sino Y'; no one-line "
    "closers, run-ups, forced triads, bold-label lists or stock AI words; spell out "
    "internal codes for a human reader; never change a fact while smoothing. "
    "Applies to chat replies and to everything written into a repo."
)

# (label, regex, strong). Strong tells also block commit messages.
I = re.IGNORECASE
CHECKS = [
    # An unspaced en dash is a range (January–February, §1–§13b) and stays.
    ("em/en dash in prose (use . , : or parentheses)", re.compile(r"—|\s–|–\s"), True),
    ("spaced double hyphen used as a dash", re.compile(r"(?<=\S) -- (?=\S)"), True),
    ("'not X but Y' contrast", re.compile(
        r"\bnot (?:just|only|merely|simply)\b|\bit'?s not\b[^.\n]{1,60}[,;] it'?s\b"
        r"|\bisn'?t about\b|\bthis (?:does not|doesn't) mean\b", I), True),
    ("'no es X, sino Y' contrast", re.compile(
        r"\bno (?:es|son|era|fue)? ?(?:s[oó]lo|solamente|simplemente|meramente)\b"
        r"|\bno (?:es|son|era|fue)\b[^.\n]{1,60}\bsino\b", I), True),
    ("chatbot wrapper", re.compile(
        r"\b(?:I hope this helps|great question|let me know if you'?d like|"
        r"you'?re absolutely right|espero que (?:esto )?(?:te |le )?(?:ayude|sirva)|"
        r"buena pregunta|tienes toda la raz[oó]n)\b", I), True),
    ("run-up before the point", re.compile(
        r"\b(?:here'?s the thing|let'?s (?:dive|break (?:this|it) down|explore)|"
        r"without further ado|quick note|the thing is|real talk|"
        r"vamos a (?:desglosar|profundizar)|sin m[aá]s pre[aá]mbulos)\b", I), False),
    ("saying that sounds deep", re.compile(
        r"\b(?:at its core|the real question is|what really matters|the heart of the matter|"
        r"en el fondo|la verdadera pregunta es|lo que realmente importa)\b", I), False),
    ("one-line closer", re.compile(
        r"^(?:that(?: is|'s) the (?:real )?(?:win|point|key)|that distinction matters|"
        r"let that sink in|read that again|eso es (?:lo (?:importante|clave)|la clave))\.?$",
        I | re.MULTILINE), False),
    ("stock AI word", re.compile(
        r"\b(?:delve|delves|delving|pivotal|crucial|robust|seamless(?:ly)?|leverag(?:e|es|ing)|"
        r"showcas(?:e|es|ing)|underscor(?:e|es|ing)|testament|tapestry|meticulous(?:ly)?|"
        r"intricate|vibrant|landscape|garner(?:s|ed)?|"
        r"crucial(?:es)?|robust[oa]s?|exhaustiv[oa]s?|minucios[oa]s?|sin fisuras|"
        r"(?:punto|aspecto|factor|pieza|elemento)s? clave|es clave)\b", I), False),
    ("'serves as' / 'stands as' instead of is/has", re.compile(
        r"\b(?:serves|stands|functions) as\b|\bfunciona como\b|\bse erige como\b", I), False),
]
BOLD_LABEL = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+\*\*[^*\n]{1,40}?:?\*\*:?", re.MULTILINE)
MD_LINK = re.compile(r"\[([^\]\n]*)\]\([^)\n]*\)")
# Link text with no spaces that holds a slash or ends in a file extension (and maybe :line).
PATH_TEXT = re.compile(r"\S*/\S*|\S+\.[A-Za-z0-9]{1,8}(?::\d+)?")
# A cell holding only a dash, bounded by a pipe on at least one side. `| a — b |` stays prose.
_DASH_CELL = r"[ \t]*(?:[—–]+|-{2,})[ \t]*"
EMPTY_CELL = re.compile(rf"(?m)(?<=\|){_DASH_CELL}(?=\||$)|^{_DASH_CELL}(?=\|)")


def strip_code(text):
    """Drop fenced blocks, inline code, URLs and CLI flags so only prose is checked."""
    text = re.sub(r"(?ms)^\s*(```|~~~).*?^\s*\1[^\n]*$", "", text)
    # Placeholders, not empty strings, so `0001`–`0033` stays an unspaced range.
    text = re.sub(r"`[^`\n]*`", "CODE", text)
    text = re.sub(r"https?://\S+", "URL", text)
    return text


def strip_layout(prose):
    """Drop what is layout and not writing: link targets, link text that only names a path,
    and table cells that only hold a dash. Words in a link and dashes beside one stay."""
    prose = MD_LINK.sub(lambda m: "CODE" if PATH_TEXT.fullmatch(m.group(1)) else m.group(1), prose)
    return EMPTY_CELL.sub(" ", prose)


def find_tells(text, strong_only=False):
    prose = strip_code(text)
    written = strip_layout(prose)
    hits = []
    for label, rx, strong in CHECKS:
        if strong_only and not strong:
            continue
        for m in rx.finditer(written):
            start = written.rfind("\n", 0, m.start()) + 1
            end = written.find("\n", m.end())
            line = written[start:end if end != -1 else None].strip()
            hits.append(f"- {label}: \"{line[:140]}\"")
    # Counted before strip_layout: a label too long to match must not start matching
    # because its link target went away.
    if not strong_only and len(BOLD_LABEL.findall(prose)) >= 3:
        hits.append("- bold-label list (3+ items start with **Label:**); turn it into prose if the labels add nothing")
    seen, out = set(), []
    for h in hits:
        if h not in seen:
            seen.add(h)
            out.append(h)
    return out


FENCE = re.compile(r"(?ms)^\s*(```|~~~).*?^\s*\1[^\n]*$")
# The memory system's own index format: `- [Title](file.md) — hook`.
MEMORY_INDEX_DASH = re.compile(r"(?m)^(\s*- \[[^\]\n]*\]\([^)\n]*\)) — ")


def blank_fences(text):
    """Fenced blocks become spaces of the same length, so offsets still line up."""
    return FENCE.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def in_context(fragment, path):
    """An edited fragment as it reads in the file: lines inside a fence there are code,
    even though the fragment alone carries no fence markers."""
    try:
        with open(path, encoding="utf-8") as f:
            whole = f.read()
    except (OSError, UnicodeDecodeError):
        return fragment
    at = whole.find(fragment)
    if not fragment or at == -1:
        return fragment
    return blank_fences(whole)[at:at + len(fragment)]


def written_text(tool_name, tool_input):
    path = tool_input.get("file_path", "")
    if tool_name == "Write":
        return tool_input.get("content", "")
    if tool_name == "Edit":
        return in_context(tool_input.get("new_string", ""), path)
    if tool_name == "MultiEdit":
        return "\n".join(in_context(e.get("new_string", ""), path)
                         for e in tool_input.get("edits", []))
    return ""


def is_memory_index(path):
    full = os.path.abspath(os.path.expanduser(path))
    return os.path.basename(full) == "MEMORY.md" and os.path.basename(os.path.dirname(full)) == "memory"


def is_prose_file(path):
    if not path:
        return False
    full = os.path.abspath(os.path.expanduser(path))
    if any(full.startswith(p) or full == p.rstrip("/") for p in SKIP_PATHS):
        return False
    if "/node_modules/" in full:
        return False
    # This plugin's skill quotes the tells. The hook runs from the install cache, so
    # its own location says nothing about where the repo copy being edited lives.
    if "/plugins/humanizer/skills/humanizer/" in full:
        return False
    # Agent working notes, never a deliverable: SDD ledgers and briefs under a
    # repo's git-ignored .superpowers/, and files in a session's scratchpad.
    if "/.superpowers/" in full:
        return False
    if full.startswith(("/private/tmp/claude-", "/tmp/claude-")):
        return False
    base = os.path.basename(full)
    return os.path.splitext(base)[1].lower() in PROSE_EXT or base == "COMMIT_EDITMSG"


def report(hits):
    shown = hits[:MAX_HITS]
    more = len(hits) - len(shown)
    return "\n".join(shown) + (f"\n- ...and {more} more" if more > 0 else "")


def mode_prompt():
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit", "additionalContext": REMINDER}}))


def mode_post(payload):
    tool_input = payload.get("tool_input") or {}
    path = tool_input.get("file_path", "")
    if not is_prose_file(path):
        return
    text = written_text(payload.get("tool_name", ""), tool_input)
    if is_memory_index(path):
        text = MEMORY_INDEX_DASH.sub(r"\1: ", text)
    hits = find_tells(text)
    if not hits:
        return
    print(json.dumps({
        "decision": "block",
        "reason": (
            f"Humanizer check on {os.path.basename(path)}: the text you just wrote has AI-writing tells. "
            "Rewrite those sentences now (keep every fact; quotations, titles and established "
            "project terms can stay):\n" + report(hits)),
    }))


# `git commit` or `gh pr create|edit` where a command starts (line start, or after
# ; & | ( or env assignments), with git's own -c/-C options allowed in between.
# A line that only mentions git and commit, such as a string in a script, is no call.
COMMIT_CALL = re.compile(
    r"(?m)(?:^|[;&|(])\s*(?:[A-Za-z_]\w*=\S*\s+)*"
    r"(?:git(?:\s+-[cC]\s+\S+)*\s+commit\b|gh\s+pr\s+(?:create|edit)\b)")
HEREDOC = re.compile(r"""<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s;&|()<>'"]+))""")


def command_skeleton(cmd, bodies=None, keep_words=False):
    """The command with every quoted string turned into Q, escaped characters into _,
    line continuations into a space and heredoc bodies dropped, so COMMIT_CALL sees
    only real command starts. A heredoc body is never read as a command, whatever
    command takes it (so `bash <<EOF` holding a commit is not caught, like `bash -c`);
    each body goes into `bodies` when a list is given, in order. With `keep_words`
    quoted strings and escapes stay as written and the heredoc marks go, which leaves
    the shell words for shell_steps.
    Returns None when the command cannot be scanned (an unclosed quote or heredoc)."""
    out, pending, i, n = [], [], 0, len(cmd)
    while i < n:
        c = cmd[i]
        if c == "\\":
            out.append(" " if cmd[i + 1:i + 2] == "\n" else cmd[i:i + 2] if keep_words else "_")
            i += 2
        elif c == "'" or cmd.startswith("$'", i):
            j = i + (2 if c == "$" else 1)
            while j < n and cmd[j] != "'":
                j += 2 if c == "$" and cmd[j] == "\\" else 1
            if j >= n:
                return None
            out.append(cmd[i:j + 1] if keep_words else "Q")
            i = j + 1
        elif c == '"':
            j = i + 1
            while j < n and cmd[j] != '"':
                j += 2 if cmd[j] == "\\" else 1
            if j >= n:
                return None
            out.append(cmd[i:j + 1] if keep_words else "Q")
            i = j + 1
        elif cmd.startswith("<<<", i):  # a here-string: its word is scanned as usual
            out.append("<<<")
            i += 3
        elif c == "<" and (m := HEREDOC.match(cmd, i)):
            word = next(w for w in m.group(2, 3, 4) if w is not None).replace("\\", "")
            pending.append((word, m.group(1) == "-"))
            out.append("" if keep_words else "H")
            i = m.end()
        elif c == "\n" and pending:
            # The heredoc bodies start on the next line, one after the other.
            i += 1
            for word, strip_tabs in pending:
                lines = []
                while True:
                    end = cmd.find("\n", i)
                    line = cmd[i:end if end != -1 else n]
                    i = end + 1 if end != -1 else n
                    if strip_tabs:
                        line = line.lstrip("\t")
                    if line == word:
                        break
                    if end == -1:
                        return None
                    lines.append(line)
                if bodies is not None:
                    bodies.append("\n".join(lines))
            pending = []
            out.append("\n")
        else:
            out.append(c)
            i += 1
    return None if pending else "".join(out)


def file_text(path):
    """The file's prose, with the memory index's own dashes left alone."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if is_memory_index(path):
        text = MEMORY_INDEX_DASH.sub(r"\1: ", text)
    return text


LEADING_CD = re.compile(r"^\s*cd\s+(?:\"([^\"]+)\"|'([^']+)'|(\S+))\s*(?:&&|;)")


def shell_steps(cmd):
    """Each simple command in `cmd`, in order, as its list of unquoted words, with
    redirects and comments dropped. None when the command cannot be scanned."""
    text = command_skeleton(cmd, keep_words=True)
    if text is None:
        return None
    steps, pos, after_redirect = [[]], 0, False
    while pos < len(text):
        m = SHELL_TOKEN.match(text, pos)
        if not m:
            if text[pos:].strip():
                return None
            break
        pos = m.end()
        operator, redirect, word = m.groups()
        if operator:
            steps.append([])
            after_redirect = False
        elif redirect:
            after_redirect = True
        elif after_redirect:
            after_redirect = False
        elif word.startswith("#"):
            end = text.find("\n", pos)
            pos = end if end != -1 else len(text)
        else:
            steps[-1].append(unquote(word))
    return [step for step in steps if step]


def expands(word):
    """A word the shell fills in, so the hook cannot know what it will be."""
    return "$" in word or "`" in word


def git_call(words, cwd):
    """(folder, subcommand, its arguments) for a git command, else None."""
    if words[0] != "git":
        return None
    i = 1
    while i < len(words):
        word = words[i]
        if word == "-C":
            cwd = os.path.join(cwd, os.path.expanduser(words[i + 1])) if i + 1 < len(words) else cwd
            i += 2
        elif word == "-c":
            i += 2
        elif word.startswith("-"):
            i += 1
        else:
            return cwd, word, words[i + 1:]
    return None


# Options of `git commit` that take the next word as their value.
COMMIT_LONG_VALUES = {"--message", "--file", "--author", "--date", "--template", "--reuse-message",
                      "--reedit-message", "--fixup", "--squash", "--trailer", "--cleanup",
                      "--pathspec-from-file"}
COMMIT_SHORT_VALUES = "mFCct"
# Short options whose optional value can only be stuck to them.
COMMIT_SHORT_STUCK = "Su"


def commit_options(args):
    """(-a or --all given, the paths named, -i or --include given) for `git commit`."""
    takes_all, include, paths, i = False, False, [], 0
    while i < len(args):
        word = args[i]
        i += 1
        if word == "--":
            paths += args[i:]
            break
        if word.startswith("--"):
            takes_all = takes_all or word == "--all"
            include = include or word == "--include"
            if word in COMMIT_LONG_VALUES:
                i += 1
        elif word.startswith("-") and len(word) > 1:
            for k, letter in enumerate(word[1:], 2):
                takes_all = takes_all or letter == "a"
                include = include or letter == "i"
                if letter in COMMIT_SHORT_VALUES:
                    # A value stuck to the letter (-mFix) leaves the next word alone.
                    i += 0 if k < len(word) else 1
                    break
                if letter in COMMIT_SHORT_STUCK:
                    break
        else:
            paths.append(word)
    return takes_all, paths, include


def add_options(args):
    """(tracked files only, pathspecs) for `git add`, or None when it stages nothing."""
    tracked_only, whole, specs, literal = False, False, [], False
    for word in args:
        if literal or not word.startswith("-") or word == "-":
            specs.append(":/" if expands(word) else word)
        elif word == "--":
            literal = True
        elif word == "--dry-run":
            return None
        elif word.startswith("--"):
            tracked_only = tracked_only or word == "--update"
            whole = whole or word == "--all" or word.startswith("--pathspec-from-file")
        else:
            if "n" in word:
                return None
            tracked_only = tracked_only or "u" in word
            whole = whole or "A" in word
    if not specs and (whole or tracked_only):
        specs = [":/"]
    return (tracked_only, specs) if specs else None


def commit_scopes(cmd, payload):
    """One (folder, takes the index, working-tree pathspecs, earlier adds) for each commit
    in the command, following `cd` and `git -C`. A `git add` runs after this hook, so what
    it will stage has to be worked out here; each add is (folder, tracked only, pathspecs).
    A command that cannot be read counts as a plain commit in the hook's cwd."""
    start = cwd = os.path.expanduser(payload.get("cwd") or os.getcwd())
    scopes, adds = [], []
    for words in shell_steps(cmd) or []:
        while words and ENV_WORD.match(words[0]):
            words = words[1:]
        if not words:
            continue
        if words[0] == "cd":
            targets = [w for w in words[1:] if not w.startswith("-")]
            if targets and not expands(targets[0]):
                cwd = os.path.join(cwd, os.path.expanduser(targets[0]))
            continue
        call = git_call(words, cwd)
        if call is None:
            continue
        where, subcommand, args = call
        if subcommand == "add":
            add = add_options(args)
            if add:
                adds.append((where, *add))
        elif subcommand == "commit":
            takes_all, named, include = commit_options(args)
            # A word that is no file on disk is no path: a message whose inner quotes
            # split it can leave stray words behind.
            paths = [p for p in named if os.path.exists(os.path.join(where, p))]
            tree = [":/"] if takes_all else paths
            scopes.append((where, takes_all or include or not paths, tree, list(adds)))
    return scopes or [(start, True, [], [])]


def run_git(where, *args, stdin=None):
    """Stdout of `git -C where args`, as bytes. Raises when git fails."""
    return subprocess.run(["git", "-C", where, *args], input=stdin, capture_output=True,
                          timeout=5, check=True).stdout


def git_names(where, *args):
    """The NUL-separated file names a git command prints."""
    return [n for n in run_git(where, *args).decode("utf-8", "replace").split("\0") if n]


def git_top(where):
    return run_git(where, "rev-parse", "--show-toplevel").decode("utf-8", "replace").strip()


def changed_names(where, specs):
    """Files under `specs` whose working copy differs from HEAD, named from the repo root.
    A repo with no commits has no HEAD, so there the index and the working tree are asked."""
    base = ("diff", "--name-only", "--diff-filter=ACMR", "-z")
    try:
        return git_names(where, *base, "HEAD", "--", *specs)
    except subprocess.CalledProcessError:
        return git_names(where, *base, "--cached", "--", *specs) + git_names(where, *base, "--", *specs)


def diff_path(field):
    """The file name in a diff's `+++ b/name` line. Git quotes a name with odd characters
    and puts a tab after one with spaces."""
    field = field.rstrip("\t")
    if field.startswith('"'):
        field = codecs.escape_decode(field[1:-1].encode())[0].decode("utf-8", "replace")
    return field[2:] if field.startswith("b/") else field


def added_lines(top, names, cached):
    """{name: the new-file line numbers the commit adds} from one -U0 diff against HEAD
    (the index with `cached`, the working tree without). None when the diff cannot be read,
    such as a repo with no commits: the whole file counts then."""
    if not names:
        return {}
    try:
        raw = run_git(top, "-c", "core.quotepath=off", "--literal-pathspecs", "diff", "-U0", "--no-color",
                      "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/",
                      "--cached" if cached else "HEAD", "--", *names).decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return None
    lineas, actual, in_header = {}, None, False
    # Every line of a hunk has a prefix, so these three shapes only match real headers.
    for line in raw.split("\n"):
        if line.startswith("diff --git "):
            actual, in_header = None, True
        elif in_header and line.startswith("+++ "):
            actual = diff_path(line[4:])
            lineas[actual] = set()
        elif line.startswith("@@"):
            in_header = False
            m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
            if m and actual is not None:
                inicio = int(m.group(1))
                cuantas = 1 if m.group(2) is None else int(m.group(2))
                lineas[actual].update(range(inicio, inicio + cuantas))
    return lineas


def index_texts(top, names):
    """{name: its text in the index} from one `git cat-file --batch`. A name holding a
    newline cannot be asked for this way and is left out."""
    names = [n for n in names if "\n" not in n]
    if not names:
        return {}
    raw = run_git(top, "cat-file", "--batch", stdin="".join(f":{n}\n" for n in names).encode())
    texts, pos = {}, 0
    for name in names:
        end = raw.index(b"\n", pos)
        header = raw[pos:end].split(b" ")
        pos = end + 1
        if len(header) == 3 and header[1] == b"blob":
            size = int(header[2])
            texts[name] = raw[pos:pos + size].decode("utf-8", "replace")
            pos += size + 1
    return texts


def scope_prose(where, takes_index, tree_specs, adds):
    """{(repo, name): the lines the commit would add} for one commit's prose files. The
    working tree's copy wins over the index's for a file a -a, a named path or an add
    will take. Fences are blanked over the whole file first, so an added line inside one
    stays code. Text already in HEAD never comes back, so old tells cannot block."""
    top = git_top(where)
    index, tree, new = [], [], []
    if takes_index:
        index = git_names(top, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    if tree_specs:
        tree = changed_names(where, tree_specs)
    for add_where, tracked_only, specs in adds:
        if git_top(add_where) != top:
            continue
        tree += changed_names(add_where, specs)
        if not tracked_only:
            new += git_names(add_where, "ls-files", "-o", "--exclude-standard", "--full-name", "-z", "--", *specs)

    def prose(names, *taken):
        return [n for n in dict.fromkeys(names)
                if is_prose_file(os.path.join(top, n)) and not any(n in t for t in taken)]

    new = prose(new)
    tree = prose(tree, new)
    index = prose(index, new, tree)
    cached, worked = added_lines(top, index, cached=True), added_lines(top, tree, cached=False)
    index_text = index_texts(top, index)
    out = {}
    for name in new + tree + index:
        path = os.path.join(top, name)
        try:
            if name in index:
                text = index_text[name]
                if is_memory_index(path):
                    text = MEMORY_INDEX_DASH.sub(r"\1: ", text)
            else:
                text = file_text(path)
        except (OSError, UnicodeDecodeError, KeyError):
            continue
        lines = cached if name in index else worked
        if name not in new and lines is not None:
            nuevas = lines.get(name, set())
            todas = blank_fences(text).split("\n")
            text = "\n".join(l for i, l in enumerate(todas, 1) if i in nuevas)
        out[top, name] = text
    return out


def staged_prose_files(cmd, payload):
    """(name, text) for every prose file the command's commits would take, cut down to the
    lines they add. When git cannot answer for a commit, that commit's files are not read."""
    found = {}
    for scope in commit_scopes(cmd, payload):
        try:
            found.update(scope_prose(*scope))
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    return [(name, text) for (_, name), text in found.items()]


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


# One shell word: plain characters, backslash escapes and quoted runs.
SHELL_WORD = r"""(?:[^\s"'\\;&|()<>]|\\.|"(?:[^"\\]|\\.)*"|'[^']*'|\$'(?:[^'\\]|\\.)*')+"""
# The next token of a command: what ends a step, a redirect (2>&1, >, <<<), or a word.
SHELL_TOKEN = re.compile(r"[ \t]*(?:(\n|&&|\|\||[;&|()])|(\d*(?:<<<|[<>]+&?))|(" + SHELL_WORD + "))")
ENV_WORD = re.compile(r"[A-Za-z_]\w*=")
# A commit message, or a PR title or body, given inline as the option's word, which
# may be stuck to a short option (-m"Fix" or -mFix).
INLINE_TEXT = re.compile(
    r"(?<!\S)(?:-[mtb]|--(?:message|title|body)(?![\w-])|-[a-ln-zA-Z]+m)(?:=|\s*)("
    + SHELL_WORD + ")")
# One read from a file; `-` is stdin, which a heredoc or here-string feeds.
TEXT_FILE = re.compile(r"(?<!\S)(?:-F|--file|--body-file)(?:=|\s*)(" + SHELL_WORD + ")")
HERE_STRING = re.compile(r"<<<\s*(" + SHELL_WORD + ")")
# A file the command writes (`> file`), whose contents the hook would read stale.
WRITTEN_FILE = re.compile(r">\s*(" + SHELL_WORD + ")")
# The folder a `git -C` names, which the commit's paths are relative to.
GIT_C = re.compile(r"(?<!\S)git(?:\s+-c\s+\S+)*\s+-C\s+(" + SHELL_WORD + ")")


def unquote(word):
    """The text a shell word stands for, its quotes and backslashes taken off."""
    out, i, n = [], 0, len(word)
    while i < n:
        c = word[i]
        if c == "\\" and i + 1 < n:
            out.append(word[i + 1])
            i += 2
        elif word.startswith("$'", i):
            j = i + 2
            while j < n and word[j] != "'":
                j += 2 if word[j] == "\\" else 1
            raw = word[i + 2:j]
            try:
                # Non-ASCII text becomes \uXXXX first, so a dash survives the decode.
                out.append(raw.encode("latin-1", "backslashreplace").decode("unicode_escape"))
            except UnicodeDecodeError:
                out.append(raw)
            i = j + 1
        elif c == "'":
            j = word.find("'", i + 1)
            j = n if j == -1 else j
            out.append(word[i + 1:j])
            i = j + 1
        elif c == '"':
            j = i + 1
            while j < n and word[j] != '"':
                if word[j] == "\\" and j + 1 < n and word[j + 1] in '"\\$`':
                    out.append(word[j + 1])
                    j += 2
                else:
                    out.append(word[j])
                    j += 1
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def message_texts(cmd, bodies, payload):
    """(label, text) for each message a commit or PR command carries: the words given
    inline, the heredoc and here-string bodies, and the files it names, read from disk.
    A relative file is taken from the folder `git -C` names, else where a leading `cd`
    goes, else the hook's cwd; a `cd` later in the command is not followed, and a file
    that cannot be read is skipped. A file the command itself writes is skipped too:
    what is on disk is stale, and the body written is scanned as a heredoc or a word."""
    texts = [("the message", unquote(m.group(1))) for m in INLINE_TEXT.finditer(cmd)]
    texts += [("the here-string", unquote(m.group(1))) for m in HERE_STRING.finditer(cmd)]
    texts += [("the heredoc", body) for body in bodies]
    written = {unquote(m.group(1)) for m in WRITTEN_FILE.finditer(cmd)}
    cwd = os.path.expanduser(payload.get("cwd") or ".")
    cd = LEADING_CD.match(cmd)
    if cd:
        cwd = os.path.join(cwd, os.path.expanduser(next(g for g in cd.groups() if g)))
    for m in TEXT_FILE.finditer(cmd):
        name = unquote(m.group(1))
        if name == "-" or name in written:
            continue
        base = cwd
        git_c = GIT_C.search(cmd, 0, m.start())
        if git_c:
            base = os.path.join(cwd, os.path.expanduser(unquote(git_c.group(1))))
        path = os.path.join(base, os.path.expanduser(name))
        try:
            with open(path, encoding="utf-8") as f:
                texts.append((path, f.read(200_000)))
        except (OSError, ValueError):  # ValueError covers bad UTF-8 and a NUL in the name
            pass
    return texts


def mode_commit(payload):
    cmd = (payload.get("tool_input") or {}).get("command", "")
    bodies = []
    skeleton = command_skeleton(cmd, bodies)
    # Unscannable: a false deny beats a missed check, so match the raw command.
    call = COMMIT_CALL.search(cmd if skeleton is None else skeleton)
    if not call:
        return
    if re.search(r"(?:^|\s)HUMANIZER_OK=1\s", cmd):
        return
    if skeleton is None:
        # No message can be picked out of a command that cannot be scanned, so the
        # whole of it is read, flags aside.
        texts = [("the command", re.sub(r"(?<!\S)--?[A-Za-z][\w-]*", " ", cmd))]
    else:
        texts = message_texts(cmd, bodies, payload)
    blocks = []
    for label, text in texts:
        hits = find_tells(text, strong_only=True)
        if hits:
            blocks.append(f"{label}:\n" + report(hits))
    if blocks:
        deny("Humanizer check: the commit message or PR body has AI-writing tells. Rewrite it and run "
             "the command again (prefix HUMANIZER_OK=1 only if a tell is a deliberate quotation):\n"
             + "\n".join(blocks))
        return
    if "commit" not in call.group(0):
        return
    blocks = []
    for name, staged in staged_prose_files(cmd, payload):
        file_hits = find_tells(staged)
        if file_hits:
            blocks.append(f"{name}:\n" + report(file_hits))
    if blocks:
        deny("Humanizer check: a line this commit adds to a staged file has AI-writing tells. Rewrite "
             "those sentences, stage the file again and run the commit again (keep every fact; prefix "
             "HUMANIZER_OK=1 only if the tells are quotations):\n" + "\n".join(blocks))


def transcript_closing_text(path):
    """The closing message read from the end of the transcript, for a Claude Code that
    sends no last_assistant_message. The file can lag behind the conversation, so only
    assistant text at its very end counts: a tail ending in a tool call or in anything
    from the user means the closing message is not there yet, and gives nothing."""
    try:
        with open(os.path.expanduser(path), encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return ""
    parts = []
    for line in reversed(lines):
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("isSidechain"):
            continue
        if record.get("type") == "user":
            break
        if record.get("type") != "assistant":
            continue
        content = (record.get("message") or {}).get("content")
        blocks = content if isinstance(content, list) else []
        if any(b.get("type") == "tool_use" for b in blocks):
            break
        parts[:0] = [b.get("text", "") for b in blocks if b.get("type") == "text"]
    return "\n".join(parts)


def closing_message(payload):
    """The field first: the docs say the transcript may not hold the message at Stop time.
    An empty field is an answer (the turn ended with no text), so only a missing one falls back."""
    text = payload.get("last_assistant_message")
    if isinstance(text, str):
        return text
    return transcript_closing_text(payload.get("transcript_path") or "")


def mode_stop(payload):
    # Set when another Stop hook sent the turn back: this message's turn was already checked.
    if payload.get("stop_hook_active"):
        return
    hits = find_tells(closing_message(payload))
    if hits:
        print(json.dumps({"systemMessage": "Humanizer check on the closing message:\n" + report(hits)}))


def mode_file(path):
    try:
        hits = find_tells(file_text(path))
    except (OSError, UnicodeDecodeError) as exc:
        print(f"cannot read {path}: {exc}", file=sys.stderr)
        return 2
    if hits:
        print(f"{path}:\n" + report(hits))
        return 1
    return 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "prompt":
        mode_prompt()
        return
    if mode == "file":
        if len(sys.argv) < 3:
            print("usage: humanizer_check.py file PATH", file=sys.stderr)
            sys.exit(2)
        sys.exit(mode_file(sys.argv[2]))
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return
    if mode == "post":
        mode_post(payload)
    elif mode == "commit":
        mode_commit(payload)
    elif mode == "stop":
        mode_stop(payload)


if __name__ == "__main__":
    main()
