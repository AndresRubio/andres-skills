"""Read a Bash command the way the shell would split it, for the guard hooks.

`simple_commands(text)` gives the simple commands the text runs, each as its list of
words with the quotes taken off. A quoted string is one word whatever it holds, so an
operator or a `#` inside it splits nothing. Commands end at `;`, `&&`, `||`, `|`, `&`,
a newline and either bracket. A comment runs from an unquoted `#` that starts a word to
the end of its line. `<` and `>` end a word.

A substitution, `$(...)` or backticks, is a command of its own, also inside double
quotes, and leaves the word `$(...)` where its output would go: `cd $(pwd)/tmp` is the
commands `cd $(...)/tmp` and `pwd`.

A heredoc's body is no command. It is kept as text on the command it feeds, in that
command's `heredocs` list, for a caller that wants to read it.

What it does not know: `$((...))` arithmetic is read as a substitution. A quote that
never closes raises ValueError, and so does nesting too deep to follow.
"""
import sys

HOLE = "$(...)"


def _closing(text, start):
    """The index of the `)` that closes a `$(` whose body starts at `start`, or -1."""
    depth = 0
    i = start
    while i < len(text):
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                return -1
            i = j
        elif c == "(":
            depth += 1
        elif c == ")":
            if depth == 0:
                return i
            depth -= 1
        i += 1
    return -1


class Words(list):
    """The words of one simple command, with the heredoc bodies it was fed."""

    def __init__(self, *args):
        super().__init__(*args)
        self.heredocs = []


def _delimiter(text, start):
    """(delimiter, strips_tabs, index after it) for a heredoc whose `<<` ends at `start`."""
    i = start
    strips_tabs = text[i:i + 1] == "-"
    if strips_tabs:
        i += 1
    while text[i:i + 1] in (" ", "\t"):
        i += 1
    if text[i:i + 1] in ("'", '"'):
        end = text.find(text[i], i + 1)
        if end < 0:
            raise ValueError("a heredoc delimiter's quote does not close")
        return text[i + 1:end], strips_tabs, end + 1
    end = i
    while end < len(text) and text[end] not in " \t\r\n;&|()<>":
        end += 1
    return text[i:end].replace("\\", ""), strips_tabs, end


def _body(text, start, delimiter, strips_tabs):
    """(body, index after the delimiter's line) for a heredoc whose body starts at
    `start`. A body nothing closes runs to the end."""
    lines = []
    i = start
    while i < len(text):
        end = text.find("\n", i)
        end = len(text) if end < 0 else end
        line = text[i:end]
        i = end + 1
        if (line.lstrip("\t") if strips_tabs else line) == delimiter:
            break
        lines.append(line)
    return "\n".join(lines), min(i, len(text))


def simple_commands(text):
    try:
        return _simple_commands(text)
    except RecursionError:
        raise ValueError("substitutions nested too deep to follow") from None


def _simple_commands(text):
    commands = []
    words = Words()
    word = None
    # Heredocs opened on this line: their bodies start after its newline.
    opened = []
    is_in_backticks = False

    def end_word():
        nonlocal word
        if word is not None:
            words.append(word)
            word = None

    def end_command():
        nonlocal words
        end_word()
        if words:
            commands.append(words)
            words = Words()

    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            if text[i + 1:i + 2] != "\n":
                word = (word or "") + text[i + 1:i + 2]
            i += 2
        elif c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise ValueError("a single quote does not close")
            word = (word or "") + text[i + 1:j]
            i = j + 1
        elif c == '"':
            held = ""
            j = i + 1
            while j < n and text[j] != '"':
                if text[j] == "\\" and text[j + 1:j + 2] in ('"', "\\", "$", "`", "\n"):
                    held += "" if text[j + 1] == "\n" else text[j + 1]
                    j += 2
                elif text.startswith("$(", j) or text[j] == "`":
                    # A substitution runs inside double quotes too.
                    opens = 2 if text[j] == "$" else 1
                    end = _closing(text, j + 2) if text[j] == "$" else text.find("`", j + 1)
                    if end < 0:
                        raise ValueError("a substitution does not close")
                    commands.extend(_simple_commands(text[j + opens:end]))
                    held += HOLE
                    j = end + 1
                else:
                    held += text[j]
                    j += 1
            if j >= n:
                raise ValueError("a double quote does not close")
            word = (word or "") + held
            i = j + 1
        elif c in " \t\r":
            end_word()
            i += 1
        elif c == "#" and word is None:
            end = text.find("\n", i)
            i = n if end < 0 else end
        elif text.startswith("$(", i):
            word = (word or "") + HOLE
            end_command()
            i += 2
        elif c in "`)":
            # After a substitution closes, what is glued to it is the rest of the word
            # its output went into.
            is_opening = c == "`" and not is_in_backticks
            if c == "`":
                is_in_backticks = not is_in_backticks
            if is_opening:
                word = (word or "") + HOLE
            end_command()
            i += 1
            if not is_opening and i < n and text[i] not in " \t\r\n;&|()<>`":
                word = HOLE
        elif c == "\n":
            end_command()
            i += 1
            for target, delimiter, strips_tabs in opened:
                body, i = _body(text, i, delimiter, strips_tabs)
                target.heredocs.append(body)
            opened = []
        elif c in ";&|(":
            end_command()
            i += 1
        elif text.startswith("<<<", i):
            # A here-string: the word after it is ordinary.
            end_word()
            i += 3
        elif text.startswith("<<", i):
            end_word()
            delimiter, strips_tabs, i = _delimiter(text, i + 2)
            opened.append((words, delimiter, strips_tabs))
        elif c in "<>":
            end_word()
            i += 1
        else:
            word = (word or "") + c
            i += 1
    end_command()
    return commands
