---
name: confession-box
description: Use when the user asks Claude to confess, own up to, fess up, come clean, or honestly report shortcuts and cheats taken during a coding session, such as skipped or weakened tests, mocks that hide the real logic, suppressed type errors (`# type: ignore`, `Any`, `cast`), ignored lint warnings (`# noqa`, `pragma: no cover`), hardcoded values to make tests green, swallowed exceptions, `--no-verify`, or unfinished work hidden behind happy-path code. Invoke this skill whenever the user mentions "confession", "confess", "come clean", "fess up", "any shortcuts?", "anything you cheated on", "be honest about what you did", "did you cut corners", or similar honest-retrospective phrasing, even if they don't name the skill explicitly.
---

# Confession box

The user wants an honest accounting of the shortcuts you took in this session, so they can decide whether each one is acceptable. Report every shortcut you find, including the small ones and the ones you think were justified. The user decides what is acceptable.

Every confession rests on evidence: a tool call in the session log, a line in the diff, or a command you ran. Evidence is what makes the list trustworthy, whether it holds five items or none. A complete walk that finds nothing is a valid result.

State what you did and where. When context is needed, give it in one short clause.

## 1. Gather the evidence

Work from the record. Your memory of a long or compacted session drops exactly the small details a confession needs.

Run this block in a single shell call, since variables don't carry over between calls. It picks the current session's log: the most recently modified `.jsonl` for this working directory. When the user names a session or a log file, set `LOG` to that file instead.

```bash
D="$HOME/.claude/projects/$(pwd | sed 's/[^a-zA-Z0-9]/-/g')"
LOG="$D/$(ls -t "$D" | grep '\.jsonl$' | head -1)"
PAT='type: ?ignore|@ts-(ignore|expect-error)|noqa|eslint-disable|nolint|#\[allow|pragma: no cover|istanbul ignore|[sS]kip\(|mark\.skip|xfail|\bxit\(|except\b[^:]*:|catch *(\([^)]*\))? *\{ *\}|unwrap_or|NotImplementedError|unimplemented|not implemented|TODO|FIXME|--no-verify|--no-gpg-sign|gpgsign=false|\bAny\b|cast\(|unsafeCast| as any\b'
SINCE=$(jq -r '.timestamp // empty' "$LOG" | head -1)

# Tool calls, in order
jq -r 'select(.type=="assistant") | .timestamp as $t | .message.content[]? | select(.type=="tool_use") | "\($t)\t\(.name)\t\(.input.file_path // .input.command // "")"' "$LOG"

# Pattern hits in what you wrote and ran
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .input as $i | (($i.new_string // $i.content // $i.command // "") | split("\n")[]) | "\($i.file_path // "(command)")\t\(.)"' "$LOG" | grep -E "$PAT"

# In a git repo: pattern hits in the session's added lines, then in new untracked files
{ git diff HEAD; git log -p --since="$SINCE"; } | grep -E "^\+\+\+ |^\+.*($PAT)"
git ls-files -z --others --exclude-standard | xargs -0 -r grep -HnE "$PAT"
```

The `+++` lines are file headers that label the hits under them. In a git repo, also read the full diff (`git diff HEAD` and `git log -p --since="$SINCE"`), because a weakened test often shows up only as removed lines, which the scan skips.

Read every hit in context. A hit is a lead, and it becomes a confession once the context shows a real shortcut. A pattern inside a string, a test fixture, documentation, or a pattern list like the one above is no shortcut.

When no log exists, work from memory and say so at the top of the report. Step 1 is done when you have the tool-call list, both scans have run, and you have read the full diff, or you have noted which source was unavailable.

## 2. Walk the five categories

Check each category below, in order, against the evidence from step 1 and against what you told the user. Walk all five, including the ones you expect to be clean: a checked category with nothing in it is how the user knows the review was thorough. Some shortcuts never match a pattern (a weakened assertion, a subset of tests reported as "all passing", a special-cased input), so read the edits themselves, beyond the scan hits. Step 2 is done when every category has either confessions with evidence or a clean result.

### 1. Tests

- Skipped tests (`@pytest.mark.skip`, `pytest.skip`, `xfail`, `it.skip`, `xit`, `describe.skip`, etc.)
- Commented out or deleted a failing test instead of fixing the underlying code
- Weakened an assertion to make it pass: loosened a tolerance, changed `==` to `>=`, narrowed an input range, replaced a deep equality check with "contains", asserted on length instead of contents
- Mocked or stubbed the very logic the test was supposed to exercise (the mock returns the answer the test checks for)
- Hardcoded a value in the implementation specifically because a test expected that value
- Ran only the tests you knew would pass; reported "tests pass" without saying which subset
- Wrote a test that exercises only the happy path when the bug was in an edge case

### 2. Type checker / lint

- Added `# type: ignore`, `# type: ignore[...]`, `// @ts-ignore`, `// @ts-expect-error`, `# noqa`, `eslint-disable`, `// nolint`, `#[allow(...)]`, etc.
- Widened a type to `Any`, `unknown`, `object`, `interface{}`, or used `cast()` / `as` / `unsafeCast` without verifying the cast actually holds
- Suppressed a warning at the call site instead of fixing the root cause where it originated
- Marked code with `# pragma: no cover`, `/* istanbul ignore */`, or similar to dodge a coverage threshold
- Disabled a lint rule in config to make the file pass

### 3. Logic shortcuts

- Bare `except:`, `except Exception:` without re-raising, empty `catch {}`, `catch (_)`, `.unwrap_or(default)` to silence a real error
- Returned a default value, empty list, or `None` to make an error path go away instead of handling it
- Special-cased the specific input the user mentioned (`if name == "andres": ...`) instead of fixing the general case the input revealed
- Left a `TODO`, `FIXME`, `raise NotImplementedError`, `panic!("unimplemented")`, or `throw new Error("not implemented")` while reporting the function as done
- Stubbed out a function with a hardcoded return value and didn't flag it
- Wrote code that "works" only because nothing currently calls it with the problematic input

### 4. Verification / CI

- Used `--no-verify`, `--no-gpg-sign`, `-c commit.gpgsign=false`, or similar to bypass a pre-commit hook
- Skipped running the test suite, type checker, or linter before claiming the work was done
- Ran a subset of tests and reported "all passing" without naming the subset
- Claimed something works without actually executing it (no run, no test, just inspection)
- Said "this should work" or "this is correct" when you didn't verify

### 5. Scope drift

- Refactored, renamed, or reformatted code unrelated to the task
- Added abstractions, helpers, config knobs, or "for future use" hooks that weren't requested
- Deleted code you judged unused without checking
- Modified files outside what the user asked you to touch
- Added comments, docstrings, or documentation the user didn't ask for

## 3. Report

Reply with these sections in this order.

### Confessions

A bullet list. Each bullet: *what you did*, *where* (file:line, or the command you ran), and one short clause on *why*. Every bullet points at something in the evidence from step 1. Be specific: "I added `# type: ignore[arg-type]` at `foo.py:42` because the dict had mixed value types and I didn't want to introduce a TypedDict" is a real confession. When you can point at the evidence but aren't sure it counts as a shortcut, say so.

### Clean conscience

One line per category with no confessions, naming what you checked (for example: "Type checker / lint: scanned the diff and log for suppressions, none added"). List only categories you actually walked. When every category has at least one confession, write one line saying so. With no confessions at all, say so plainly and list all five here.

### Prevent it next time

Include this section when at least one confession is something an automated check could have caught. For each of those, name the check that would have caught it: a lint rule, a pre-commit hook, or a CI job. End the section by suggesting the user run `/retro`, which turns findings like these into changes to the repo. Only the user can start `/retro`.

Close with one question when there are confessions: which of them should you fix now.
