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
          denied while a line it adds to a staged .md/.txt/.rst file has any
          tell, whatever tool wrote it (a Bash heredoc never reaches the post
          hook); text already in HEAD never blocks. Prefix the command with
          HUMANIZER_OK=1 to pass a message or added lines whose tells are
          deliberate (a quote).
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
    # This plugin's own files quote the tells. The hook runs from the install cache,
    # so its own location says nothing about where the repo copy being edited lives.
    if "/plugins/humanizer/" in full:
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


def command_skeleton(cmd, bodies=None):
    """The command with every quoted string turned into Q, escaped characters into _,
    line continuations into a space and heredoc bodies dropped, so COMMIT_CALL sees
    only real command starts. A heredoc body is never read as a command, whatever
    command takes it (so `bash <<EOF` holding a commit is not caught, like `bash -c`);
    each body goes into `bodies` when a list is given, in order.
    Returns None when the command cannot be scanned (an unclosed quote or heredoc)."""
    out, pending, i, n = [], [], 0, len(cmd)
    while i < n:
        c = cmd[i]
        if c == "\\":
            out.append(" " if cmd[i + 1:i + 2] == "\n" else "_")
            i += 2
        elif c == "'" or cmd.startswith("$'", i):
            j = i + (2 if c == "$" else 1)
            while j < n and cmd[j] != "'":
                j += 2 if c == "$" and cmd[j] == "\\" else 1
            if j >= n:
                return None
            out.append("Q")
            i = j + 1
        elif c == '"':
            j = i + 1
            while j < n and cmd[j] != '"':
                j += 2 if cmd[j] == "\\" else 1
            if j >= n:
                return None
            out.append("Q")
            i = j + 1
        elif cmd.startswith("<<<", i):  # a here-string: its word is scanned as usual
            out.append("<<<")
            i += 3
        elif c == "<" and (m := HEREDOC.match(cmd, i)):
            word = next(w for w in m.group(2, 3, 4) if w is not None).replace("\\", "")
            pending.append((word, m.group(1) == "-"))
            out.append("H")
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


def repo_dir(cmd, payload):
    """Where the commit runs: a leading `cd DIR &&`, else the hook's cwd."""
    m = LEADING_CD.match(cmd)
    if m:
        target = os.path.expanduser(next(d for d in m.groups() if d is not None))
        if os.path.isabs(target):
            return target
    return payload.get("cwd") or os.getcwd()


def added_lines(cwd, name, cached):
    """The new-file line numbers a commit of `name` would add, read from a -U0 diff
    against HEAD (the index with `cached`, the working tree without, for -a). None when
    the diff cannot be read, such as a repo with no commits: the whole file counts then."""
    base = ["git", "-C", cwd, "diff", "-U0"] + (["--cached"] if cached else ["HEAD"])
    try:
        raw = subprocess.run(base + ["--", name], capture_output=True, timeout=5,
                             check=True).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return None
    lineas = set()
    for m in re.finditer(r"(?m)^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", raw):
        inicio = int(m.group(1))
        cuantas = 1 if m.group(2) is None else int(m.group(2))
        lineas.update(range(inicio, inicio + cuantas))
    return lineas


def staged_prose_files(cmd, payload):
    """(path, text) for every prose file the commit would take, cut down to the lines
    the commit adds (fences blanked over the whole file first, so an added line inside
    one stays code). With -a or --all the tracked files changed in the working tree
    count too. Text already in HEAD never comes back, so old tells cannot block."""
    cwd = repo_dir(cmd, payload)
    args = ["git", "-C", cwd, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]

    def listed(extra_args):
        raw = subprocess.run(extra_args, capture_output=True, timeout=5).stdout
        return [n for n in raw.decode("utf-8", "replace").split("\0") if n]

    try:
        staged = listed(args)
        # -a commits the working tree's version of every changed tracked file.
        worktree = (listed(args[:4] + args[5:])
                    if re.search(r"(?<!\S)(?:-a|--all)(?!\S)", command_skeleton(cmd) or cmd) else [])
    except (OSError, subprocess.SubprocessError):
        return []
    out = []
    for name in dict.fromkeys(worktree + staged):
        path = os.path.join(cwd, name)
        if not is_prose_file(path):
            continue
        try:
            if name in worktree:
                text = file_text(path)
            else:
                text = subprocess.run(["git", "-C", cwd, "show", f":{name}"], capture_output=True,
                                      timeout=5, check=True).stdout.decode("utf-8", "replace")
                if is_memory_index(path):
                    text = MEMORY_INDEX_DASH.sub(r"\1: ", text)
        except (OSError, UnicodeDecodeError, subprocess.SubprocessError):
            continue
        nuevas = added_lines(cwd, name, cached=name not in worktree)
        if nuevas is not None:
            todas = blank_fences(text).split("\n")
            text = "\n".join(l for i, l in enumerate(todas, 1) if i in nuevas)
        out.append((name, text))
    return out


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


# One shell word: plain characters, backslash escapes and quoted runs.
SHELL_WORD = r"""(?:[^\s"'\\;&|()<>]|\\.|"(?:[^"\\]|\\.)*"|'[^']*'|\$'(?:[^'\\]|\\.)*')+"""
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
        except (OSError, UnicodeDecodeError):
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
