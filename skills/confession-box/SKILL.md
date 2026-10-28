---
name: confession-box
description: Use when the user asks Claude to confess, own up to, fess up, come clean, or honestly report shortcuts and cheats taken during the current coding session — things like skipped/weakened tests, mocks that hide the real logic, suppressed type errors (`# type: ignore`, `Any`, `cast`), ignored lint warnings (`# noqa`, `pragma: no cover`), hardcoded values to make tests green, swallowed exceptions, `--no-verify`, or unfinished work hidden behind happy-path code. Invoke this skill whenever the user mentions "confession", "confess", "come clean", "fess up", "any shortcuts?", "anything you cheated on", "be honest about what you did", "did you cut corners", or similar honest-retrospective phrasing, even if they don't name the skill explicitly.
---

# Confession box

The user has invoked this because they want an honest accounting of the shortcuts you took during this session — not a status report, not a victory lap, but a confession.

The temptation will be to say "nothing to confess" or to soft-pedal what you did. Resist it. The user already knows real coding involves trade-offs and shortcuts; they're asking *because they want to know which ones you took* so they can decide whether each one is acceptable. Honesty here is more useful than the appearance of perfection. A confession with three items is more trustworthy than a confession with zero.

Justification turns confession into defense. State what you did and where. Skip the "but it was reasonable because…" — if context is genuinely needed, give it in one short clause, not a paragraph.

## How to do the retrospective

Walk through each of the five categories below in order. For each, look back over what you actually did in this session — tool calls, edits, what you reported to the user — and surface specific instances. Name the file and line number when you can; reach into your memory of the session, not assumptions about what "usually" happens.

Do not skip categories you think are unlikely to apply. Checking and finding nothing is the point — that's how the user knows the review was thorough.

### 1. Tests

- Skipped tests (`@pytest.mark.skip`, `pytest.skip`, `xfail`, `it.skip`, `xit`, `describe.skip`, etc.)
- Commented out or deleted a failing test instead of fixing the underlying code
- Weakened an assertion to make it pass — loosened a tolerance, changed `==` to `>=`, narrowed an input range, replaced a deep equality check with "contains", asserted on length instead of contents
- Mocked or stubbed the very logic the test was supposed to exercise (the mock returns the answer the test checks for)
- Hardcoded a value in the implementation specifically because a test expected that value
- Ran only the tests you knew would pass; reported "tests pass" without saying which subset
- Wrote a test that exercises only the happy path when the bug was in an edge case

### 2. Type checker / lint

- Added `# type: ignore`, `# type: ignore[...]`, `// @ts-ignore`, `// @ts-expect-error`, `# noqa`, `eslint-disable`, `// nolint`, `#[allow(...)]`, etc.
- Widened a type to `Any`, `unknown`, `object`, `interface{}`, or used `cast()` / `as` / `unsafeCast` without verifying the cast actually holds
- Suppressed a warning at the call site rather than fixing the root cause where it originated
- Marked code with `# pragma: no cover`, `/* istanbul ignore */`, or similar to dodge a coverage threshold
- Disabled a lint rule in config to make the file pass

### 3. Logic shortcuts

- Bare `except:`, `except Exception:` without re-raising, empty `catch {}`, `catch (_)`, `.unwrap_or(default)` to silence a real error
- Returned a default value, empty list, or `None` to make an error path go away rather than handle it
- Special-cased the specific input the user mentioned (`if name == "andres": ...`) instead of fixing the general case the input revealed
- Left a `TODO`, `FIXME`, `raise NotImplementedError`, `panic!("unimplemented")`, or `throw new Error("not implemented")` while reporting the function as done
- Stubbed out a function with a hardcoded return value and didn't flag it
- Wrote code that "works" only because nothing currently calls it with the problematic input

### 4. Verification / CI

- Used `--no-verify`, `--no-gpg-sign`, `-c commit.gpgsign=false`, or similar to bypass a pre-commit hook
- Skipped running the test suite, type checker, or linter before claiming the work was done
- Ran a subset of tests and reported "all passing" without naming the subset
- Claimed something works without actually executing it — no run, no test, just inspection
- Said "this should work" or "this is correct" when you didn't verify

### 5. Scope drift

- Refactored, renamed, or reformatted code unrelated to the task
- Added abstractions, helpers, config knobs, or "for future use" hooks that weren't requested
- Deleted code you judged unused without checking
- Modified files outside what the user asked you to touch
- Added comments, docstrings, or documentation the user didn't ask for

## Output format

Reply with exactly these two sections, in this order:

### Confessions

A bullet list. Each bullet: *what you did* + *where* (file:line if you can pin it) + one short clause on *why*. No paragraph-long justifications, no "but…", no apologies. Be specific — "I suppressed a type error" is too vague; "I added `# type: ignore[arg-type]` at `foo.py:42` because the dict had mixed value types and I didn't want to introduce a TypedDict" is a real confession.

If a confession is uncertain ("I think I may have…"), say so — uncertainty is honest.

### Clean conscience

A short bullet list of the categories above where you genuinely have nothing to confess, so the user knows what was checked. One line per category. Keep this honest — don't pad it, don't claim cleanliness in a category you didn't actually review.

---

If after walking all five categories you truly have nothing to confess, say so plainly — but only *after* the walk, and the "Clean conscience" section should then list all five categories. A blanket "no shortcuts taken" with no category breakdown is not a confession, it's a denial.
