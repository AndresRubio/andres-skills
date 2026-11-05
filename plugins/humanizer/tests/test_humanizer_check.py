"""Tests for humanizer_check.py. Run: python3 plugins/humanizer/tests/test_humanizer_check.py

Each test feeds the hook the payload Claude Code would send and reads what it prints:
nothing means "let it through", JSON means "block" (post) or "deny" (commit).
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest

_HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")
_RUTA = os.path.join(_HOOKS, "humanizer_check.py")
_spec = importlib.util.spec_from_file_location("humanizer_check", _RUTA)
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)


def salida(funcion, payload):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        funcion(payload)
    return buf.getvalue().strip()


def commit(cmd):
    return salida(hc.mode_commit, {"tool_input": {"command": cmd}})


class Commit(unittest.TestCase):
    def test_a_real_commit_with_a_dash_is_denied(self):
        self.assertIn("deny", commit('git commit -m "one thing -- another"'))

    def test_a_commit_with_identity_flags_after_cd_is_denied(self):
        cmd = 'cd repo && git -c user.name=A -c user.email=a@b commit -q -m "x -- y"'
        self.assertIn("deny", commit(cmd))

    def test_a_commit_message_from_a_heredoc_is_checked(self):
        cmd = "git commit -q -F - <<'EOF'\nA line — with a dash\nEOF"
        self.assertIn("deny", commit(cmd))

    def test_a_pr_body_is_checked(self):
        self.assertIn("deny", commit('gh pr create --body "it is — done"'))

    def test_humanizer_ok_lets_a_quotation_through(self):
        self.assertEqual("", commit('HUMANIZER_OK=1 git commit -m "a — b"'))

    def test_a_script_that_mentions_git_and_commit_on_one_line_is_not_a_commit(self):
        # 2026-10-21: a python heredoc writing an AGENTS.md line was denied.
        cmd = ("python3 - <<'EOF'\n"
               'l = "git config core.hooksPath .githooks   # runs ruff and mypy before each commit"\n'
               'm = "uv run python -m tests.apoyo.mutar F V N -- tests/x.py"\n'
               "EOF")
        self.assertEqual("", commit(cmd))

    def test_git_log_grepping_for_commit_is_not_a_commit(self):
        self.assertEqual("", commit('git log --grep "commit -- x" --oneline'))


class CommitQuoting(unittest.TestCase):
    """Whether a command is a commit call is read with quotes and heredoc bodies taken
    out; the text checked for tells is still the whole command."""

    def test_a_python_one_liner_printing_a_commit_payload_is_not_a_commit(self):
        # 2026-10-21: denied because `&& git -c ... commit` sat inside the single quotes.
        cmd = ("python3 -c 'import json; print(json.dumps({\"tool_input\": {\"command\": "
               "\"cd r && git -c user.name=A commit -m \\\"a — b\\\"\"}}))'")
        self.assertEqual("", commit(cmd))

    def test_echo_mentioning_git_commit_is_not_a_commit(self):
        self.assertEqual("", commit('echo "run git commit later -- maybe"'))

    def test_a_command_start_inside_double_quotes_is_not_a_commit(self):
        self.assertEqual("", commit('echo "done; git commit -m later -- maybe"'))

    def test_the_quote_escape_idiom_does_not_throw_the_scanner_off(self):
        self.assertEqual("", commit("echo 'it'\\''s; git commit -- later'"))

    def test_a_dollar_single_quoted_string_is_not_a_command(self):
        self.assertEqual("", commit("printf $'a\\'; git commit -- b\\n'"))

    def test_bash_dash_c_is_out_of_scope(self):
        # The inner command is a commit, but the hook does not look inside bash -c
        # strings (it never did). Recorded here so a change is deliberate.
        self.assertEqual("", commit("bash -c 'git commit -m \"a — b\"'"))

    def test_a_heredoc_body_line_starting_with_git_commit_is_not_a_command(self):
        # Heredoc bodies are never read as commands, whatever command takes them.
        cmd = "cat > notes.txt <<'EOF'\ngit commit -m \"a — b\"\nEOF"
        self.assertEqual("", commit(cmd))

    def test_an_unquoted_heredoc_delimiter_is_checked(self):
        self.assertIn("deny", commit("git commit -q -F - <<EOF\nA line — with a dash\nEOF"))

    def test_a_double_quoted_heredoc_delimiter_is_checked(self):
        self.assertIn("deny", commit('git commit -q -F - <<"EOF"\nA line — with a dash\nEOF'))

    def test_a_tab_stripping_heredoc_is_checked(self):
        self.assertIn("deny", commit("git commit -q -F - <<-EOF\n\tA line — with a dash\n\tEOF"))

    def test_a_commit_after_a_heredoc_is_still_a_commit(self):
        cmd = "cat > f <<'EOF'\nnotes\nEOF\ngit commit -m \"a — b\""
        self.assertIn("deny", commit(cmd))

    def test_a_message_from_cat_heredoc_with_quotes_inside_is_checked(self):
        cmd = "git commit -m \"$(cat <<'EOF'\nSay \"hi\" — now, it's done\nEOF\n)\""
        self.assertIn("deny", commit(cmd))

    def test_escaped_double_quotes_in_a_message_are_checked(self):
        self.assertIn("deny", commit('git commit -m "say \\"hi\\" — now"'))

    def test_a_commit_in_command_substitution_is_a_commit(self):
        self.assertIn("deny", commit('x=$(git commit -m "a — b")'))

    def test_a_commit_in_a_subshell_is_a_commit(self):
        self.assertIn("deny", commit('(cd r && git commit -m "a — b")'))

    def test_a_line_continuation_between_git_and_commit_is_a_commit(self):
        self.assertIn("deny", commit('git \\\n  commit -m "a — b"'))

    def test_a_here_string_is_not_a_heredoc(self):
        self.assertEqual("", commit('cat <<<"x; git commit -- y"'))

    def test_unbalanced_quotes_fall_back_to_the_plain_match(self):
        self.assertIn("deny", commit('git commit -m "a — b'))


def post(ruta, tool_name, tool_input):
    entrada = {"file_path": ruta, **tool_input}
    return salida(hc.mode_post, {"tool_name": tool_name, "tool_input": entrada})


class Post(unittest.TestCase):
    def setUp(self):
        self.carpeta = tempfile.mkdtemp()

    def escribir(self, nombre, texto):
        ruta = os.path.join(self.carpeta, nombre)
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        with open(ruta, "w") as f:
            f.write(texto)
        return ruta

    def test_prose_with_a_dash_is_blocked(self):
        ruta = self.escribir("doc.md", "Intro.\n\nThe tool works -- mostly.\n")
        self.assertIn("block", post(ruta, "Edit", {"new_string": "The tool works -- mostly.\n"}))

    def test_an_edited_line_inside_a_fenced_block_is_code(self):
        # 2026-10-21: an Edit adding a command line inside ```bash was read as prose.
        linea = "uv run python -m tests.apoyo.mutar F V N -- tests/x.py -q   # exit 0 caught\n"
        ruta = self.escribir("AGENTS.md", f"Commands:\n\n```bash\nuv run pytest\n{linea}```\n\nMore prose.\n")
        self.assertEqual("", post(ruta, "Edit", {"new_string": linea}))

    def test_prose_edited_next_to_a_fenced_block_is_still_checked(self):
        nuevo = "The block above runs it — every time.\n"
        ruta = self.escribir("AGENTS.md", f"```bash\nx -- y\n```\n{nuevo}")
        self.assertIn("block", post(ruta, "Edit", {"new_string": nuevo}))

    def test_multiedit_lines_inside_a_fence_are_code(self):
        linea = "cmd -- arg\n"
        ruta = self.escribir("doc.md", f"Text.\n\n```\n{linea}```\n")
        self.assertEqual("", post(ruta, "MultiEdit", {"edits": [{"new_string": linea}]}))

    def test_a_memory_index_line_keeps_its_prescribed_dash(self):
        # The memory system prescribes `- [Title](file.md) — hook` for MEMORY.md.
        texto = "- [Branches](branches.md) — main = origin; two branches unmerged\n"
        ruta = self.escribir("proyecto/memory/MEMORY.md", texto)
        self.assertEqual("", post(ruta, "Edit", {"new_string": texto}))

    def test_a_dash_inside_a_memory_index_hook_is_still_flagged(self):
        texto = "- [Branches](branches.md) — main is ahead — and nobody knows why\n"
        ruta = self.escribir("proyecto/memory/MEMORY.md", texto)
        self.assertIn("block", post(ruta, "Edit", {"new_string": texto}))

    def test_another_markdown_file_named_memory_is_not_exempt(self):
        texto = "- [Branches](branches.md) — main = origin\n"
        ruta = self.escribir("docs/MEMORY.md", texto)
        self.assertIn("block", post(ruta, "Edit", {"new_string": texto}))

    def test_superpowers_working_notes_are_not_prose(self):
        # SDD ledgers live in the git-ignored .superpowers/ and follow the
        # plugin's own formats, em dash included.
        texto = "# SDD ledger — plan: docs/superpowers/plans/x.md\n"
        ruta = self.escribir(".superpowers/sdd/x/progress.md", texto)
        self.assertEqual("", post(ruta, "Write", {"content": texto}))

    def test_a_session_scratchpad_file_is_not_prose(self):
        texto = "Notas de trabajo — borrador.\n"
        ruta = "/private/tmp/claude-501/una-sesion/scratchpad/notas.md"
        self.assertEqual("", post(ruta, "Write", {"content": texto}))


def git(carpeta, *args):
    subprocess.run(["git", "-C", carpeta, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                   check=True, capture_output=True)


class CommitStagedFiles(unittest.TestCase):
    """A commit is denied while a staged prose file has a tell. The hook reads the index
    (`git show :name`), and the working tree only for -a/--all."""

    MALO = "Intro.\n\nThe tool works -- mostly.\n"
    BUENO = "Intro.\n\nThe tool works, mostly.\n"

    def setUp(self):
        self.repo = tempfile.mkdtemp()
        git(self.repo, "init", "-q")

    def escribir(self, nombre, texto, stage=True):
        ruta = os.path.join(self.repo, nombre)
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        with open(ruta, "w") as f:
            f.write(texto)
        if stage:
            git(self.repo, "add", nombre)
        return ruta

    def commit(self, cmd='git commit -q -m "add notes"', cwd=None):
        payload = {"tool_input": {"command": cmd}, "cwd": cwd or self.repo}
        return salida(hc.mode_commit, payload)

    def test_a_staged_doc_with_a_dash_is_denied(self):
        self.escribir("docs/notes.md", self.MALO)
        out = self.commit()
        self.assertIn("a line this commit adds to a staged file has AI-writing tells", out)
        self.assertIn("docs/notes.md", out)

    def test_the_repo_comes_from_a_leading_cd(self):
        self.escribir("notes.md", self.MALO)
        cmd = f'cd {self.repo} && git commit -q -m "add notes"'
        self.assertIn("deny", self.commit(cmd, cwd="/"))

    def test_a_clean_staged_doc_passes(self):
        self.escribir("notes.md", self.BUENO)
        self.assertEqual("", self.commit())

    def test_a_staged_code_file_is_not_prose(self):
        self.escribir("tool.py", "x = 1  # works -- mostly\n")
        self.assertEqual("", self.commit())

    def test_only_the_index_counts_without_dash_a(self):
        self.escribir("notes.md", self.BUENO)
        git(self.repo, "commit", "-q", "-m", "clean")
        self.escribir("notes.md", self.MALO, stage=False)
        self.assertEqual("", self.commit())

    def test_dash_a_takes_the_working_tree_version(self):
        self.escribir("notes.md", self.BUENO)
        git(self.repo, "commit", "-q", "-m", "clean")
        self.escribir("notes.md", self.MALO, stage=False)
        self.assertIn("deny", self.commit('git commit -q -a -m "update notes"'))

    def test_double_dash_all_takes_the_working_tree_version(self):
        self.escribir("notes.md", self.BUENO)
        git(self.repo, "commit", "-q", "-m", "clean")
        self.escribir("notes.md", self.MALO, stage=False)
        self.assertIn("deny", self.commit('git commit -q --all -m "update notes"'))

    def test_a_staged_clean_version_passes_even_if_the_working_tree_is_dirty(self):
        self.escribir("notes.md", self.BUENO)
        self.escribir("notes.md", self.MALO, stage=False)
        self.assertEqual("", self.commit())

    def test_a_dash_in_a_fenced_block_is_code(self):
        self.escribir("notes.md", "Run it:\n\n```bash\ntool -- --flag\n```\n")
        self.assertEqual("", self.commit())

    def test_the_message_is_checked_before_the_files(self):
        self.escribir("notes.md", self.MALO)
        out = self.commit('git commit -q -m "add notes -- finally"')
        self.assertIn("the commit message or PR body", out)
        self.assertNotIn("a staged file", out)

    def test_humanizer_ok_skips_the_staged_files(self):
        self.escribir("notes.md", self.MALO)
        self.assertEqual("", self.commit('HUMANIZER_OK=1 git commit -q -m "quote"'))

    def test_a_pr_body_does_not_look_at_staged_files(self):
        self.escribir("notes.md", self.MALO)
        self.assertEqual("", self.commit('gh pr create --title t --body "plain body"'))

    def test_outside_a_repo_the_commit_passes(self):
        fuera = tempfile.mkdtemp()
        self.assertEqual("", self.commit(cwd=fuera))

    def test_a_memory_index_keeps_its_prescribed_dash(self):
        self.escribir("memory/MEMORY.md", "- [Branches](branches.md) — main = origin\n")
        self.assertEqual("", self.commit())

    def test_old_tells_do_not_block_a_clean_addition(self):
        self.escribir("notes.md", self.MALO)
        git(self.repo, "commit", "-q", "-m", "legacy")
        self.escribir("notes.md", self.MALO + "\nA clean new line.\n")
        self.assertEqual("", self.commit())

    def test_a_new_bad_line_in_a_file_with_old_tells_is_denied(self):
        self.escribir("notes.md", self.MALO)
        git(self.repo, "commit", "-q", "-m", "legacy")
        self.escribir("notes.md", self.MALO + "\nAnother thought -- barely.\n")
        out = self.commit()
        self.assertIn("deny", out)
        self.assertIn("Another thought", out)
        self.assertNotIn("works -- mostly", out)

    def test_an_added_line_inside_an_existing_fence_is_code(self):
        self.escribir("notes.md", "Run it:\n\n```bash\ntool --flag\n```\n")
        git(self.repo, "commit", "-q", "-m", "fence")
        self.escribir("notes.md", "Run it:\n\n```bash\ntool --flag\ntool -- --other\n```\n")
        self.assertEqual("", self.commit())

    def test_dash_a_checks_only_the_lines_it_adds(self):
        self.escribir("notes.md", self.MALO)
        git(self.repo, "commit", "-q", "-m", "legacy")
        self.escribir("notes.md", self.MALO + "\nA clean new line.\n", stage=False)
        self.assertEqual("", self.commit('git commit -q -a -m "update notes"'))


class FileMode(unittest.TestCase):
    """`humanizer_check.py file PATH`: 1 and the tells on stdout, 0 clean, 2 unreadable."""

    def setUp(self):
        self.carpeta = tempfile.mkdtemp()

    def escribir(self, nombre, texto):
        ruta = os.path.join(self.carpeta, nombre)
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        with open(ruta, "w") as f:
            f.write(texto)
        return ruta

    def archivo(self, ruta):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            codigo = hc.mode_file(ruta)
        return codigo, buf.getvalue()

    def test_a_dash_returns_one_and_names_the_file(self):
        ruta = self.escribir("doc.md", "The tool works -- mostly.\n")
        codigo, out = self.archivo(ruta)
        self.assertEqual(1, codigo)
        self.assertTrue(out.startswith(ruta + ":\n"), out)

    def test_clean_prose_returns_zero_and_prints_nothing(self):
        ruta = self.escribir("doc.md", "The tool works, mostly.\n")
        self.assertEqual((0, ""), self.archivo(ruta))

    def test_a_dash_inside_a_fence_is_code(self):
        ruta = self.escribir("doc.md", "Run:\n\n```\ntool -- x\n```\n")
        self.assertEqual((0, ""), self.archivo(ruta))

    def test_a_missing_file_returns_two(self):
        with contextlib.redirect_stderr(io.StringIO()):
            codigo, out = self.archivo(os.path.join(self.carpeta, "nope.md"))
        self.assertEqual((2, ""), (codigo, out))

    def test_a_memory_index_keeps_its_prescribed_dash(self):
        ruta = self.escribir("memory/MEMORY.md", "- [Branches](branches.md) — main = origin\n")
        self.assertEqual((0, ""), self.archivo(ruta))

    def test_the_cli_exit_code_matches(self):
        ruta = self.escribir("doc.md", "The tool works -- mostly.\n")
        r = subprocess.run(["python3", _RUTA, "file", ruta], capture_output=True, text=True)
        self.assertEqual(1, r.returncode)
        self.assertIn("doc.md:", r.stdout)
        r = subprocess.run(["python3", _RUTA, "file"], capture_output=True, text=True)
        self.assertEqual(2, r.returncode)
        self.assertIn("usage", r.stderr)


LISTA = "Done:\n\n- **One:** a\n- **Two:** b\n- **Three:** c\n"


def parar(**payload):
    return salida(hc.mode_stop, payload)


def hallazgo(out):
    """What the owner is shown. The output holds nothing else, so the turn always ends:
    decision, continue or additionalContext would send it back or stop it."""
    salida_json = json.loads(out)
    assert set(salida_json) == {"systemMessage"}, salida_json
    return salida_json["systemMessage"]


class Stop(unittest.TestCase):
    """The closing message, as the payload's last_assistant_message brings it."""

    def test_a_bold_label_list_is_shown(self):
        self.assertIn("bold-label list", hallazgo(parar(last_assistant_message=LISTA)))

    def test_two_bold_labels_are_not_a_list(self):
        self.assertEqual("", parar(last_assistant_message="- **One:** a\n- **Two:** b\n"))

    def test_a_dash_is_shown_with_its_line(self):
        out = hallazgo(parar(last_assistant_message="All done — it passed.\n"))
        self.assertIn("em/en dash", out)
        self.assertIn("All done", out)

    def test_a_soft_tell_counts_too(self):
        # The commit mode blocks on strong tells only; this one runs every check.
        self.assertIn("stock AI word", hallazgo(parar(last_assistant_message="A robust fix.\n")))

    def test_a_clean_message_passes(self):
        self.assertEqual("", parar(last_assistant_message="The tests pass, and nothing else changed.\n"))

    def test_an_empty_message_passes(self):
        self.assertEqual("", parar(last_assistant_message=""))

    def test_the_finding_says_what_it_checked(self):
        self.assertIn("closing message", hallazgo(parar(last_assistant_message=LISTA)))

    def test_many_tells_are_capped_like_the_other_modes(self):
        texto = "".join(f"Line {i} — with a dash.\n" for i in range(12))
        self.assertIn("...and 4 more", hallazgo(parar(last_assistant_message=texto)))


class StopLoopGuard(unittest.TestCase):
    def test_a_continued_turn_is_not_checked_again(self):
        self.assertEqual("", parar(last_assistant_message=LISTA, stop_hook_active=True))

    def test_a_first_stop_is_checked_when_the_flag_is_false(self):
        self.assertNotEqual("", parar(last_assistant_message=LISTA, stop_hook_active=False))

    def test_a_continued_turn_does_not_read_the_transcript_either(self):
        self.assertEqual("", parar(transcript_path="/no/such/file", stop_hook_active=True))


class StopCode(unittest.TestCase):
    """Code spans and fences are stripped as in the other modes."""

    def test_a_tell_in_inline_code_is_code(self):
        self.assertEqual("", parar(last_assistant_message="The hook flags `a — b` and `x -- y`.\n"))

    def test_a_tell_in_a_fence_is_code(self):
        texto = "Run it:\n\n```bash\ntool -- --flag\necho 'a — b'\n```\n\nThat is all.\n"
        self.assertEqual("", parar(last_assistant_message=texto))

    def test_a_bold_label_list_in_a_fence_is_code(self):
        self.assertEqual("", parar(last_assistant_message=f"Example:\n\n```\n{LISTA}```\n"))

    def test_a_tell_in_a_url_is_code(self):
        self.assertEqual("", parar(last_assistant_message="See https://example.com/a--b/robust for it.\n"))

    def test_prose_next_to_a_fence_is_still_checked(self):
        texto = "```\nok\n```\n\nThe block above runs — every time.\n"
        self.assertNotEqual("", parar(last_assistant_message=texto))

    def test_an_unspaced_range_stays(self):
        self.assertEqual("", parar(last_assistant_message="Loaded enero–febrero and `0001`–`0033`.\n"))


def texto(t):
    return {"type": "text", "text": t}


def llamada():
    return {"type": "tool_use", "name": "Bash", "input": {}}


def asistente(*bloques, lado=False):
    return {"type": "assistant", "isSidechain": lado,
            "message": {"role": "assistant", "content": list(bloques)}}


def resultado():
    return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result"}]}}


def pregunta(t="Yes, go on"):
    return {"type": "user", "message": {"role": "user", "content": t}}


class StopTranscript(unittest.TestCase):
    """Without the field the transcript is read, tail first, and the docs warn it can lag:
    only text at the very end of the file counts as the closing message."""

    def setUp(self):
        self.carpeta = tempfile.mkdtemp()

    def transcripcion(self, *registros, extra=""):
        ruta = os.path.join(self.carpeta, "sesion.jsonl")
        with open(ruta, "w", encoding="utf-8") as f:
            for r in registros:
                f.write(json.dumps(r) + "\n")
            f.write(extra)
        return ruta

    def test_without_the_field_the_transcript_is_read(self):
        ruta = self.transcripcion(pregunta(), asistente(texto(LISTA)))
        self.assertIn("bold-label list", hallazgo(parar(transcript_path=ruta)))

    def test_the_field_wins_over_the_transcript(self):
        ruta = self.transcripcion(asistente(texto(LISTA)))
        self.assertEqual("", parar(transcript_path=ruta, last_assistant_message="All clean.\n"))

    def test_an_empty_field_is_an_answer_too(self):
        # The field is there and says the turn ended with no text: nothing to check.
        ruta = self.transcripcion(asistente(texto(LISTA)))
        self.assertEqual("", parar(transcript_path=ruta, last_assistant_message=""))

    def test_a_clean_closing_message_passes(self):
        ruta = self.transcripcion(pregunta(), asistente(texto("All clean.\n")))
        self.assertEqual("", parar(transcript_path=ruta))

    def test_a_message_split_over_records_is_read_whole(self):
        # The transcript stores one record per content block.
        ruta = self.transcripcion(pregunta(),
                                  asistente(texto("- **One:** a\n- **Two:** b\n")),
                                  asistente(texto("- **Three:** c\n")))
        self.assertIn("bold-label list", hallazgo(parar(transcript_path=ruta)))

    def test_records_keep_their_order(self):
        # Read back to front, joined front to back: a fence still opens before it closes.
        ruta = self.transcripcion(asistente(texto("```\na — b\n")), asistente(texto("```\n")))
        self.assertEqual("", parar(transcript_path=ruta))

    def test_text_before_a_tool_call_is_not_the_closing_message(self):
        ruta = self.transcripcion(pregunta(), asistente(texto(LISTA)), asistente(llamada()),
                                  resultado(), asistente(texto("All clean.\n")))
        self.assertEqual("", parar(transcript_path=ruta))

    def test_a_tail_ending_in_a_tool_result_has_no_closing_message_yet(self):
        ruta = self.transcripcion(pregunta(), asistente(texto(LISTA)), asistente(llamada()), resultado())
        self.assertEqual("", parar(transcript_path=ruta))

    def test_a_tail_ending_in_a_tool_call_has_no_closing_message_yet(self):
        ruta = self.transcripcion(pregunta(), asistente(texto(LISTA)), asistente(llamada()))
        self.assertEqual("", parar(transcript_path=ruta))

    def test_an_earlier_turn_is_not_checked_again(self):
        ruta = self.transcripcion(asistente(texto(LISTA)), pregunta())
        self.assertEqual("", parar(transcript_path=ruta))

    def test_a_subagent_record_is_skipped(self):
        ruta = self.transcripcion(pregunta(), asistente(texto("All clean.\n")),
                                  asistente(texto(LISTA), lado=True))
        self.assertEqual("", parar(transcript_path=ruta))

    def test_records_that_are_not_messages_are_skipped(self):
        ruta = self.transcripcion(pregunta(), asistente(texto(LISTA)),
                                  {"type": "system"}, {"type": "custom-title", "customTitle": "x"})
        self.assertNotEqual("", parar(transcript_path=ruta))

    def test_code_in_the_transcript_is_stripped_too(self):
        ruta = self.transcripcion(asistente(texto("The hook flags `a — b`.\n")))
        self.assertEqual("", parar(transcript_path=ruta))

    def test_a_broken_line_does_not_stop_the_read(self):
        ruta = self.transcripcion(asistente(texto(LISTA)), extra="{not json\n")
        self.assertNotEqual("", parar(transcript_path=ruta))

    def test_a_missing_transcript_passes(self):
        self.assertEqual("", parar(transcript_path=os.path.join(self.carpeta, "nope.jsonl")))

    def test_no_field_and_no_path_passes(self):
        self.assertEqual("", parar())

    def test_a_tilde_path_is_expanded(self):
        ruta = self.transcripcion(asistente(texto(LISTA)))
        casa = os.path.expanduser("~")
        previo = os.environ.get("HOME")
        os.environ["HOME"] = self.carpeta
        try:
            self.assertNotEqual("", parar(transcript_path="~/sesion.jsonl"))
        finally:
            os.environ["HOME"] = previo if previo is not None else casa


class StopCli(unittest.TestCase):
    """The command as hooks.json runs it, stdin and all."""

    def correr(self, entrada):
        return subprocess.run(["python3", _RUTA, "stop"], input=entrada, capture_output=True, text=True)

    def test_a_flagged_message_prints_valid_json_and_exits_zero(self):
        r = self.correr(json.dumps({"hook_event_name": "Stop", "stop_hook_active": False,
                                    "last_assistant_message": LISTA}))
        self.assertEqual(0, r.returncode)
        self.assertIn("bold-label list", hallazgo(r.stdout))

    def test_a_clean_message_prints_nothing_and_exits_zero(self):
        r = self.correr(json.dumps({"hook_event_name": "Stop", "stop_hook_active": False,
                                    "last_assistant_message": "All clean.\n"}))
        self.assertEqual((0, "", ""), (r.returncode, r.stdout, r.stderr))

    def test_a_continued_turn_prints_nothing_and_exits_zero(self):
        r = self.correr(json.dumps({"stop_hook_active": True, "last_assistant_message": LISTA}))
        self.assertEqual((0, "", ""), (r.returncode, r.stdout, r.stderr))

    def test_stdin_that_is_not_json_is_ignored(self):
        r = self.correr("this is not json")
        self.assertEqual((0, "", ""), (r.returncode, r.stdout, r.stderr))

    def test_non_ascii_survives_the_round_trip(self):
        r = self.correr(json.dumps({"last_assistant_message": "Terminó — con eñe.\n"}, ensure_ascii=False))
        self.assertEqual(0, r.returncode)
        self.assertIn("Terminó", hallazgo(r.stdout))


class TableCells(unittest.TestCase):
    """A cell with nothing but a dash is an empty cell. Seen 2026-11-03: all 7 table rows
    flagged in a week of closing messages held exactly that."""

    def test_an_em_dash_cell_is_not_prose(self):
        self.assertEqual([], hc.find_tells("| 1 | Discover | — | agent |\n"))

    def test_an_en_dash_cell_is_not_prose(self):
        self.assertEqual([], hc.find_tells("| 1 | Discover | – | agent |\n"))

    def test_a_double_hyphen_cell_is_not_prose(self):
        self.assertEqual([], hc.find_tells("| 1 | Discover | -- | agent |\n"))

    def test_a_cell_with_no_spaces_is_not_prose(self):
        self.assertEqual([], hc.find_tells("|1|—|agent|\n"))

    def test_two_cells_in_a_row_are_not_prose(self):
        self.assertEqual([], hc.find_tells("| 1 | — | — | agent |\n"))

    def test_a_last_cell_with_no_closing_pipe_is_not_prose(self):
        self.assertEqual([], hc.find_tells("| 1 | agent | —\n"))

    def test_a_first_cell_with_no_opening_pipe_is_not_prose(self):
        self.assertEqual([], hc.find_tells("— | agent | 1\n"))

    def test_a_dash_between_words_in_a_cell_is_prose(self):
        self.assertTrue(hc.find_tells("| 1 | one thing — another | agent |\n"))

    def test_a_cell_opening_with_a_dash_and_words_is_prose(self):
        self.assertTrue(hc.find_tells("| 1 | — and then some | agent |\n"))

    def test_a_cell_closing_with_words_and_a_dash_is_prose(self):
        self.assertTrue(hc.find_tells("| 1 | and then some — | agent |\n"))

    def test_a_real_dash_next_to_an_empty_cell_is_reported(self):
        hits = hc.find_tells("| 1 | — | one thing — another |\n")
        self.assertEqual(1, len(hits))
        self.assertIn("one thing — another", hits[0])

    def test_a_line_with_a_pipe_and_a_dash_in_prose_is_prose(self):
        self.assertTrue(hc.find_tells("Use a | b — it works.\n"))

    def test_a_line_holding_only_a_dash_is_no_table(self):
        self.assertTrue(hc.find_tells("Above.\n\n—\n\nBelow.\n"))

    def test_a_dash_line_right_under_a_table_is_no_cell(self):
        self.assertTrue(hc.find_tells("| a | b |\n—\nBelow.\n"))

    def test_post_passes_an_empty_cell(self):
        tabla = "| a | b |\n|---|---|\n| 1 | — |\n"
        self.assertEqual("", post("/tmp/somewhere/doc.md", "Write", {"content": tabla}))

    def test_stop_passes_an_empty_cell(self):
        self.assertEqual("", parar(last_assistant_message="| a | b |\n|---|---|\n| 1 | — |\n"))

    def test_a_commit_passes_a_staged_empty_cell(self):
        repo = tempfile.mkdtemp()
        git(repo, "init", "-q")
        with open(os.path.join(repo, "notes.md"), "w") as f:
            f.write("| a | b |\n|---|---|\n| 1 | — |\n")
        git(repo, "add", "notes.md")
        self.assertEqual("", salida(hc.mode_commit, {"tool_input": {"command": 'git commit -q -m "notes"'},
                                                     "cwd": repo}))


class Links(unittest.TestCase):
    """A link target is an address and link text that only names a file is a path. Seen
    2026-11-03: all 16 stock-word hits on link lines were `landscape` inside a path."""

    def test_a_stock_word_in_a_target_is_not_prose(self):
        self.assertEqual([], hc.find_tells("Read [the survey](docs/landscape/survey.md) first.\n"))

    def test_a_path_as_link_text_is_not_prose(self):
        self.assertEqual([], hc.find_tells("See [knowledge/landscape/harbor.md](knowledge/landscape/harbor.md).\n"))

    def test_a_file_name_as_link_text_is_not_prose(self):
        self.assertEqual([], hc.find_tells("See [landscape-overview.md](knowledge/landscape/landscape-overview.md).\n"))

    def test_a_file_and_line_as_link_text_is_not_prose(self):
        self.assertEqual([], hc.find_tells("See [robust.py:42](src/robust.py:42).\n"))

    def test_a_double_hyphen_in_a_target_is_not_prose(self):
        self.assertEqual([], hc.find_tells("See [the note](notes/a -- b.md).\n"))

    def test_words_in_link_text_are_prose(self):
        self.assertTrue(hc.find_tells("Read [a robust fix](docs/fix.md).\n"))

    def test_a_bare_stock_word_as_link_text_is_prose(self):
        self.assertTrue(hc.find_tells("Read about the [landscape](docs/fix.md).\n"))

    def test_link_text_with_spaces_and_a_slash_is_prose(self):
        self.assertTrue(hc.find_tells("Read [a robust and/or fine fix](docs/fix.md).\n"))

    def test_link_text_with_spaces_ending_in_an_extension_is_prose(self):
        self.assertTrue(hc.find_tells("Read [the robust notes.md](docs/notes.md).\n"))

    def test_a_dash_in_link_text_is_prose(self):
        self.assertTrue(hc.find_tells("Read [one thing — another](docs/fix.md).\n"))

    def test_a_dash_after_a_link_is_prose(self):
        # Seen 2026-11-03: `- [README.md](README.md) — new table` is a real tell.
        self.assertTrue(hc.find_tells("- [README.md](README.md) — new table naming it.\n"))

    def test_a_stock_word_after_a_link_is_prose(self):
        self.assertTrue(hc.find_tells("The [fix.md](docs/fix.md) looks robust.\n"))

    def test_a_hit_reports_its_own_line_after_a_stripped_link(self):
        # Stripping shifts every offset after it, so the line must come from the same text.
        hits = hc.find_tells("See [a.md](docs/a/rather/long/target/name.md) first.\n\nOne thing — another.\n")
        self.assertEqual(1, len(hits))
        self.assertIn("One thing — another", hits[0])

    def test_a_stock_word_between_two_links_is_prose(self):
        self.assertTrue(hc.find_tells("[a.md](a.md) has a robust check and [b.md](b.md) has none.\n"))

    def test_a_stock_word_in_a_bare_path_is_still_flagged(self):
        # Out of scope, and recorded here so a change is deliberate: only links are exempt.
        self.assertTrue(hc.find_tells("The file knowledge/landscape/harbor.md moved.\n"))

    def test_square_brackets_with_no_link_are_prose(self):
        self.assertTrue(hc.find_tells("The list [a robust one] (and others) stays.\n"))

    def test_links_do_not_move_the_bold_label_count(self):
        # A label over 40 characters never counted. Taking the target out must not start it,
        # or this fix would flag more than it did.
        largas = "".join(f"- **[note-{i}.md](docs/research/2026-09-17-very-long-name-{i}.md):** x\n"
                         for i in range(3))
        self.assertEqual([], hc.find_tells(largas))
        cortas = "".join(f"- **[n{i}.md](n{i}.md):** x\n" for i in range(3))
        self.assertIn("bold-label list", hc.find_tells(cortas)[0])

    def test_post_passes_a_stock_word_in_a_path_link(self):
        texto = "See [harbor.md](knowledge/landscape/harbor.md).\n"
        self.assertEqual("", post("/tmp/somewhere/doc.md", "Write", {"content": texto}))

    def test_stop_passes_a_stock_word_in_a_path_link(self):
        texto = "See [knowledge/landscape/harbor.md](knowledge/landscape/harbor.md).\n"
        self.assertEqual("", parar(last_assistant_message=texto))

    def test_the_memory_index_dash_rule_still_holds(self):
        texto = "- [Branches](branches.md) — main is ahead — and nobody knows why\n"
        self.assertIn("block", post("/tmp/x/memory/MEMORY.md", "Edit", {"new_string": texto}))


class PluginLayout(unittest.TestCase):
    """The hook runs from the install cache and has to know the repo copy of its own files."""

    def test_this_plugins_own_files_are_skipped(self):
        for ruta in ("/repo/plugins/humanizer/skills/humanizer/SKILL.md",
                     "/home/x/.claude/plugins/marketplaces/andres-skills/plugins/humanizer/README.md"):
            self.assertFalse(hc.is_prose_file(ruta), ruta)

    def test_another_plugins_prose_is_still_checked(self):
        self.assertTrue(hc.is_prose_file("/repo/plugins/check-gate/README.md"))

    def test_a_similar_folder_name_is_still_checked(self):
        self.assertTrue(hc.is_prose_file("/repo/plugins/humanizer-notes/README.md"))

    def test_hooks_json_wires_each_mode_to_its_event(self):
        with open(os.path.join(_HOOKS, "hooks.json"), encoding="utf-8") as f:
            eventos = json.load(f)["hooks"]
        cableado = set()
        prefijo = 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/humanizer_check.py" '
        for evento, grupos in eventos.items():
            for grupo in grupos:
                for hook in grupo["hooks"]:
                    self.assertTrue(hook["command"].startswith(prefijo), hook["command"])
                    modo = hook["command"][len(prefijo):]
                    cableado.add((evento, grupo.get("matcher"), modo, hook.get("if")))
        self.assertEqual({
            ("UserPromptSubmit", None, "prompt", None),
            ("PostToolUse", "Write|Edit|MultiEdit", "post", None),
            ("PreToolUse", "Bash", "commit", "Bash(git *)"),
            ("PreToolUse", "Bash", "commit", "Bash(gh pr *)"),
            ("Stop", None, "stop", None),
        }, cableado)


if __name__ == "__main__":
    unittest.main()
