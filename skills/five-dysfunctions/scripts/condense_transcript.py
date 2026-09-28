#!/usr/bin/env python3
"""Condense a Claude Code session transcript (JSONL) into a citable timeline, with an optional signal scan.

Usage:
    python3 condense_transcript.py <session.jsonl> [--subagents] [--signals] [--thinking]
                                   [--max-chars N] [--range START:END] [--out FILE]

- Every event is prefixed with its raw JSONL line number (L123), so audit findings can be checked.
- Records re-appended with an already-seen uuid are skipped (Claude Code sometimes rewrites history).
- Harness-injected text (system reminders, command caveats, meta records) is dropped. Background
  task notifications are kept as NOTIFY lines, because they carry subagent reports.
- Subagent calls (Agent/Task) show the brief up to --max-chars (600 by default) plus its full length;
  use --max-chars 0 to read briefs whole. Vague briefs are evidence.
- --range limits the main file only; subagent timelines always print in full.
- --signals prints heuristic candidates per dysfunction level first. They are leads to read, not findings.
- --subagents also condenses <session-id>/subagents/*.jsonl next to the main file.
- --max-chars 0 means no truncation.
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

HARNESS_PREFIXES = ("<system-reminder", "<local-command", "<command-", "Caveat:", "<ci-monitor-event")
REMINDER_BLOCK = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
NOTIFY_FIELD = re.compile(r"<(status|summary|result)>(.*?)</\1>", re.S)

TEST_CMD = re.compile(r"\b(pytest|unittest|jest|vitest|mocha|rspec|go test|cargo test|npm (run )?test|pnpm (run )?test|"
                      r"yarn test|make test|tox|phpunit|dotnet test|mvn test|gradle test|manage\.py test)\b")
PARTIAL_TEST = re.compile(r"(\S+\.(py|js|ts|tsx|rb|go)\b|::|\s-k\s|--testPathPattern|\.test\.|\.spec\.)")
TESTS_CLAIM = re.compile(r"(tests?\b.{0,20}\b(pass|passing|green|pasan|en verde|ok)\b|todos los tests|all tests)", re.I)
STRONG_AGREE = re.compile(r"(you'?re (absolutely )?right|great idea|good idea|buena idea|tienes (toda la )?razón|"
                          r"excelente idea|gran idea)", re.I)
WEAK_AGREE = re.compile(r"\b(perfecto|perfect|de acuerdo|claro|absolutely|sure|vale)\b", re.I)
PROPOSAL = re.compile(r"(\?|\by si\b|\bwhat if\b|\bpodríamos\b|\bdeberíamos\b|\blet'?s\b|\bvamos a\b|"
                      r"\bmejor\b|\bdesact[ií]v\w*|\bquit[aá]\w*|\bskip\b|\bdisable\b|\bya puestos\b|\bpor qué no\b|\bwhy not\b)", re.I)
HEDGE = re.compile(r"\b(risks?|riesgos?|however|pero|aunque|caveats?|not sure|no estoy seguro|careful|cuidado|concerns?|"
                   r"problemas?|ojo|warnings?|advierto|advertencia)\b", re.I)
DOUBT = re.compile(r"\b(risky|riesgos?|arriesgad\w*|but the user wants|pero el usuario quiere|not sure|no estoy seguro|"
                   r"might break|puede romper|race( condition)?|condición de carrera|hack|won'?t scale|no escala|dangerous|"
                   r"peligros[oa]|real bug|bug real)\b", re.I)
UNVERIFIED = re.compile(r"(should (now )?(be|work|drop|stay)|debería (estar|funcionar|ir|bajar|quedar)|"
                        r"should be fine|probablemente (funcione|baje))", re.I)
SHORTCUT = re.compile(r"(--no-verify|--force\b|reset --hard|rm -rf|migrate[^\n]*--fake|mark\.skip|mark\.xfail|"
                      r"\bit\.skip|describe\.skip|\bxit\(|type: ignore|@ts-ignore|@ts-expect-error|# noqa|"
                      r"eslint-disable|pragma: no cover)")
ACTIVITY = re.compile(r"\b\d+\s+(ficheros|archivos|files|líneas|lines|subagentes|subagents|agentes|agents|commits)\b", re.I)
MENTIONS_PROBLEM = re.compile(r"\b(errors?|errores|fall\w*|fail\w*|romp\w*|rot[oa]s?|broke\w*|oops|mistakes?|"
                              r"equivoc\w*|revert\w*|deshic\w*|deshag\w*|undo|undid)\b", re.I)
CAVEAT = re.compile(r"\b(not verified|no verificad\w*|sin verificar|partial|parcial\w*|blocked|bloquead\w*|risks?|"
                    r"riesgos?|caveats?|no he podido|couldn'?t|pendientes?)\b", re.I)


def short(text, n):
    text = " ".join(str(text or "").split())
    if n <= 0 or len(text) <= n:
        return text
    return text[: n - 1] + "…"


def result_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c.get("text") or "")
            elif isinstance(c, dict):
                parts.append(f"<{c.get('type', '?')}>")
            else:
                parts.append(str(c))
        return " ".join(parts)
    return str(content)


def parse_notification(text):
    fields = {k: " ".join(v.split()) for k, v in NOTIFY_FIELD.findall(text)}
    if not fields:
        return text
    return " | ".join(fields[k] for k in ("status", "summary", "result") if fields.get(k))


def load(path, stats):
    """Parse one JSONL file into a flat list of events."""
    events, seen = [], set()

    def add(line, kind, **kw):
        kw.update(line=line, kind=kind)
        events.append(kw)

    def user_text(line, text, rec):
        if rec.get("isCompactSummary"):
            add(line, "compact_summary", text=text)
            return
        stripped = REMINDER_BLOCK.sub("", text).strip()
        if stripped.startswith("<task-notification"):
            stats["notifications"] += 1
            add(line, "notify", text=parse_notification(stripped))
            return
        if rec.get("isMeta") or not stripped or stripped.startswith(HARNESS_PREFIXES):
            stats["harness_dropped"] += 1
            return
        add(line, "user", text=stripped)

    with open(path, encoding="utf-8", errors="replace") as fh:
        for ln, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                stats["malformed_lines"] += 1
                continue
            if not isinstance(rec, dict):
                stats["non_object_lines"] += 1
                continue
            uid = rec.get("uuid")
            if uid:
                if uid in seen:
                    stats["duplicate_records"] += 1
                    continue
                seen.add(uid)
            rtype = rec.get("type")
            if rtype == "system" and rec.get("subtype") == "compact_boundary":
                add(ln, "compact")
                continue
            msg = rec.get("message")
            if rtype not in ("user", "assistant") or not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if rtype == "user":
                if isinstance(content, str):
                    user_text(ln, content, rec)
                elif isinstance(content, list):
                    for c in content:
                        if not isinstance(c, dict):
                            continue
                        if c.get("type") == "tool_result":
                            err = bool(c.get("is_error"))
                            stats["tool_errors"] += err
                            add(ln, "result", text=result_text(c.get("content")), error=err, tool_id=c.get("tool_use_id"))
                        elif c.get("type") == "text":
                            user_text(ln, c.get("text") or "", rec)
                continue
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            if not isinstance(content, list):
                continue
            for c in content:
                if not isinstance(c, dict):
                    continue
                ct = c.get("type")
                if ct == "text" and (c.get("text") or "").strip():
                    add(ln, "assistant", text=c["text"])
                elif ct == "thinking":
                    stats["thinking_blocks"] += 1
                    th = c.get("thinking") or ""
                    if th.strip():
                        add(ln, "thinking", text=th)
                    else:
                        stats["thinking_empty"] += 1
                elif ct == "tool_use":
                    inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                    add(ln, "tool", name=c.get("name") or "?", input=inp, tool_id=c.get("id"))
    return events


def tool_summary(name, inp, n):
    if name in ("Agent", "Task"):
        meta = ", ".join(str(inp[k]) for k in ("subagent_type", "model") if inp.get(k))
        desc = inp.get("description", "")
        return f"[{meta}] {short(desc, 80)} :: brief ({len(str(inp.get('prompt', '')))} chars): {short(inp.get('prompt', ''), n)}"
    if name in ("Edit", "MultiEdit") and "file_path" in inp:
        old, new = inp.get("old_string", ""), inp.get("new_string", "")
        return f"{inp['file_path']}  -«{short(old, 70)}» +«{short(new, 70)}»"
    for key in ("command", "file_path", "pattern", "url", "query", "skill", "description"):
        if key in inp:
            return f"{key}={short(inp[key], 200)}"
    return short(json.dumps(inp, ensure_ascii=False), 200)


def render(events, label, max_chars, thinking, rng, out):
    lo, hi = rng
    for e in events:
        if not (lo <= e["line"] <= hi):
            continue
        L, k = f"{label}L{e['line']}", e["kind"]
        if k == "user":
            out.write(f"\n{L} USER: {short(e['text'], max_chars)}\n")
        elif k == "assistant":
            out.write(f"{L} ASSISTANT: {short(e['text'], max_chars)}\n")
        elif k == "thinking" and thinking:
            out.write(f"{L}   (thinking) {short(e['text'], max_chars)}\n")
        elif k == "tool":
            out.write(f"{L}   → {e['name']}: {tool_summary(e['name'], e['input'], max_chars)}\n")
        elif k == "result":
            flag = "[ERROR] " if e["error"] else ""
            out.write(f"{L}   ← {flag}{short(e['text'], max_chars // 2 if max_chars > 0 else 0)}\n")
        elif k == "notify":
            out.write(f"{L}   ⇠ NOTIFY: {short(e['text'], max_chars)}\n")
        elif k == "compact":
            out.write(f"{L} ---- [context compacted] ----\n")
        elif k == "compact_summary":
            out.write(f"{L} [compaction summary] {short(e['text'], max_chars)}\n")


def scan(events, label):
    """Heuristic signal scan. Returns (line, level, message, snippet) tuples."""
    sig = []
    results = {e["tool_id"]: e for e in events if e["kind"] == "result" and e.get("tool_id")}
    assistants = [i for i, e in enumerate(events) if e["kind"] == "assistant"]

    def next_assistant_texts(i, k=3):
        return [events[j]["text"] for j in assistants if j > i][:k]

    # Level 1: tool errors never mentioned afterwards.
    for i, e in enumerate(events):
        if e["kind"] == "result" and e.get("error"):
            if not any(MENTIONS_PROBLEM.search(t) for t in next_assistant_texts(i)):
                sig.append((e["line"], 1, "tool error not mentioned in the next assistant messages", short(e["text"], 110)))

    # Level 1: an edit that reverts an earlier edit.
    edits = [(i, e) for i, e in enumerate(events) if e["kind"] == "tool" and e["name"] in ("Edit", "MultiEdit")]
    for a in range(len(edits)):
        ia, ea = edits[a]
        for b in range(a + 1, len(edits)):
            ib, eb = edits[b]
            same_file = ea["input"].get("file_path") == eb["input"].get("file_path")
            old_a, new_a = ea["input"].get("old_string", ""), ea["input"].get("new_string", "")
            old_b, new_b = eb["input"].get("old_string", ""), eb["input"].get("new_string", "")
            if same_file and (old_a or new_a) and old_b == new_a and new_b == old_a:
                between = " ".join(events[j]["text"] for j in assistants if ia < j <= ib + 2)
                if not MENTIONS_PROBLEM.search(between):
                    sig.append((eb["line"], 1, f"edit reverts the edit at L{ea['line']} with no explanation",
                                short(eb["input"].get("file_path", ""), 110)))

    # Level 2: agreement right after a user message; doubt in thinking that never reaches the user.
    last = None
    for i, e in enumerate(events):
        if e["kind"] == "assistant" and last is not None and last["kind"] == "user" \
                and (STRONG_AGREE.search(e["text"][:160])
                     or (PROPOSAL.search(last["text"]) and WEAK_AGREE.search(e["text"][:60]))):
            sig.append((e["line"], 2, "immediate agreement with a user proposal: was it evaluated?", short(e["text"], 110)))
        if e["kind"] in ("user", "assistant"):
            last = e
        if e["kind"] == "thinking" and DOUBT.search(e["text"]):
            nxt = next_assistant_texts(i, 1)
            if nxt and not HEDGE.search(nxt[0]):
                sig.append((e["line"], 2, "doubt in the reasoning not voiced in the next message", short(e["text"], 110)))

    # Level 3: short subagent briefs.
    for e in events:
        if e["kind"] == "tool" and e["name"] in ("Agent", "Task"):
            p = str(e["input"].get("prompt", ""))
            if len(p) < 300:
                sig.append((e["line"], 3, f"short subagent brief ({len(p)} chars)", short(p, 110)))

    # Level 4: test claims vs. test runs; shortcuts; subagent reports with no caveats.
    last_test = None
    for e in events:
        if e["kind"] == "tool" and e["name"] == "Bash" and TEST_CMD.search(str(e["input"].get("command", ""))):
            last_test = e
        if e["kind"] == "assistant" and TESTS_CLAIM.search(e["text"]):
            if last_test is None:
                sig.append((e["line"], 4, "claims tests pass; no test command ran before this", short(e["text"], 110)))
            else:
                cmd = str(last_test["input"].get("command", ""))
                res = results.get(last_test.get("tool_id"))
                if res is not None and res.get("error"):
                    sig.append((e["line"], 4, f"claims tests pass; the last test run (L{last_test['line']}) failed", short(cmd, 110)))
                elif PARTIAL_TEST.search(cmd):
                    sig.append((e["line"], 4, f"claims tests pass; the last test run (L{last_test['line']}) was a subset", short(cmd, 110)))
        if e["kind"] == "tool":
            blob = " ".join(str(e["input"].get(k, "")) for k in ("command", "new_string", "content"))
            m = SHORTCUT.search(blob)
            if m:
                sig.append((e["line"], 4, f"shortcut pattern: {m.group(0)}", tool_summary(e["name"], e["input"], 110)))
    agent_ids = {e["tool_id"] for e in events if e["kind"] == "tool" and e["name"] in ("Agent", "Task") and e.get("tool_id")}
    for e in events:
        is_agent_result = e["kind"] == "result" and e.get("tool_id") in agent_ids
        if (is_agent_result or e["kind"] == "notify") and re.search(r"(✅|done|hecho|listo|pasan|pass)", e["text"], re.I) \
                and not CAVEAT.search(e["text"]):
            sig.append((e["line"], 4, "subagent report claims success with no caveats: did anyone verify it?", short(e["text"], 110)))

    # Level 5: unverified outcome claims; a final report that leads with activity.
    for e in events:
        if e["kind"] == "assistant" and UNVERIFIED.search(e["text"]):
            sig.append((e["line"], 5, "outcome stated as 'should' instead of measured", short(e["text"], 110)))
    for j in assistants:
        e = events[j]
        if ACTIVITY.search(e["text"][:300]) and re.search(r"(✅|listo|done|hecho|resumen|summary)", e["text"][:300], re.I):
            sig.append((e["line"], 5, "report leads with activity counts rather than the outcome", short(e["text"], 110)))

    return [(f"{label}L{line}", lvl, msg, snip) for line, lvl, msg, snip in sorted(set(sig))]


LEVELS = {1: "1 trust", 2: "2 conflict", 3: "3 commitment", 4: "4 accountability", 5: "5 results"}


def parse_range(r):
    if not r:
        return (0, float("inf"))
    a, sep, b = r.partition(":")
    if not sep or not (a or b) or not all(x.isdigit() for x in (a, b) if x):
        raise ValueError(f"--range must look like START:END (e.g. 100:250), got {r!r}")
    return (int(a) if a else 0, int(b) if b else float("inf"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path")
    ap.add_argument("--subagents", action="store_true", help="also condense <session-id>/subagents/*.jsonl")
    ap.add_argument("--signals", action="store_true", help="print heuristic signal candidates first")
    ap.add_argument("--thinking", action="store_true", help="include non-empty thinking blocks")
    ap.add_argument("--max-chars", type=int, default=600, help="truncate texts (0 = no limit)")
    ap.add_argument("--range", default="", help="only render raw lines START:END of the main file (subagents always print in full)")
    ap.add_argument("--out", default="", help="write to this file instead of stdout")
    a = ap.parse_args()

    main_path = Path(a.path).expanduser()
    if not main_path.is_file():
        ap.error(f"not a transcript file: {main_path}")
    try:
        rng = parse_range(a.range)
    except ValueError as err:
        ap.error(str(err))
    files = [("", main_path)]
    if a.subagents:
        sub_dir = main_path.with_suffix("") / "subagents"
        if sub_dir.is_dir():
            files += [(f"{p.stem}:", p) for p in sorted(sub_dir.glob("*.jsonl"))]

    parsed = []
    for label, p in files:
        stats = Counter()
        parsed.append((label, p, load(p, stats), stats))

    out = open(a.out, "w", encoding="utf-8") if a.out else sys.stdout
    out.write(f"# Transcript: {main_path.name}\n\n")
    for label, p, events, st in parsed:
        edited = sorted({e["input"].get("file_path") for e in events
                         if e["kind"] == "tool" and e["name"] in ("Edit", "MultiEdit", "Write") and e["input"].get("file_path")})
        out.write(f"- {label or 'main:'} {p.name}: {len(events)} events; duplicates skipped {st['duplicate_records']}; "
                  f"harness dropped {st['harness_dropped']}; notifications {st['notifications']}; tool errors {st['tool_errors']}; "
                  f"thinking empty {st['thinking_empty']}/{st['thinking_blocks']}; malformed {st['malformed_lines'] + st['non_object_lines']}; "
                  f"files edited {len(edited)}\n")

    if a.signals:
        out.write("\n## SIGNALS (candidates — confirm each in the timeline before citing)\n")
        rows = [row for label, _, events, _ in parsed for row in scan(events, label)]
        for lvl in range(1, 6):
            for where, l, msg, snip in rows:
                if l == lvl:
                    out.write(f"- {where} [{LEVELS[l]}] {msg} — «{snip}»\n")
        if not rows:
            out.write("- (none)\n")

    out.write("\n## TIMELINE\n")
    for idx, (label, p, events, _) in enumerate(parsed):
        if idx:
            out.write(f"\n\n## Subagent {p.stem}\n")
        render(events, label, a.max_chars, a.thinking, rng if idx == 0 else (0, float("inf")), out)
    main_events = parsed[0][2]
    if a.range and main_events and not any(rng[0] <= e["line"] <= rng[1] for e in main_events):
        last = max(e["line"] for e in main_events)
        print(f"warning: --range {a.range} matches no events (main file events span L1..L{last})", file=sys.stderr)

    if a.out:
        out.close()
        total = sum(len(ev) for _, _, ev, _ in parsed)
        print(f"wrote {a.out} ({Path(a.out).stat().st_size // 1024} KB, {total} events)")


if __name__ == "__main__":
    main()
