# Working on the mods

Every folder in `plugins/` except `claude-pipeline/` is a mod: a Claude Code plugin whose TypeScript hooks module runs inside the session, where it can refuse or rewrite tool calls, add slash commands and draw UI. `plugins/humanizer/` uses Python command hooks instead, as described below. Load the `plugin-authoring` skill before writing mod code. It has the API summary, the examples and the path to this build's types file (about 22,000 lines: grep it for the name at hand, such as `'tool.call'` or `Pane: {`). This file holds what the skill leaves out: rules these mods learned from failed runs, how their tests are built, and what to run before you push.

`plugins/check-gate/` is the reference mod. It has a gate on Bash calls, a band above the prompt, a background process with streamed output, a slash command, a `$.state` atom, `$.store`, and tests that mock the engine. Copy its patterns.

## The Python mod

`plugins/humanizer/` is the one mod with no TypeScript module. Its `hooks/hooks.json` declares Python command hooks, because the checks are text parsing that needs nothing from the engine, and a port would mean rewriting the code and its tests with no change anyone could see. Write new mods in TypeScript.

`scripts/check-mods.sh` recognises this kind of mod by a `hooks/hooks.json` with no `"modules"` and tests at `tests/test_*.py`. It validates the plugin and runs those tests with `python3 -m unittest`. A mod that loses its tests fails the run. The numbered rules and the Tests section below are about the TypeScript API and don't apply to it.

Its commit check is an exception to the Guards section. The commit goes through when git can't answer, when a file named by `-F` can't be read, when the folder is a shell variable, or when the hook's input isn't JSON. This is deliberate, since it checks writing style and a broken check shouldn't stop work.

## A mod's folder

```text
plugins/<mod>/
├── .claude-plugin/plugin.json   # name, version, "author": { "name": "AndresRubio" }, description; "types" when it keeps $.state
├── hooks/hooks.json             # { "modules": ["./register.tsx"] }
├── hooks/register.ts(x)         # export const register: Register = (on, options) => { ... }
├── hooks/logic.ts               # pure functions the tests cover
├── tests/*.test.ts(x)           # test, expect, describe, mock from 'claude-code/testing'
├── types/index.d.ts             # only when it keeps $.state: each value in interface PluginState, under the mod's name
└── tsconfig.json                # { "extends": "./.claude-plugin/types/tsconfig.json" }
```

A new mod also gets an entry in `.claude-plugin/marketplace.json`, with a description that starts `Mod:` or `Mod for <repo>:`, and a row in the README's Mods table.

## Rules

1. Declare every helper that receives `$` at the top level of the module file, as a function declaration or a top-level `const` arrow function. `claude plugin validate` refuses a module whose `$` helpers are closures inside `register`. Module-level Maps and Sets are fine and reset on reload. A detached async IIFE inside a hook may capture `$`.
2. A hook gets 10 s of its own time. Time spent inside a `$` call or `next()` doesn't count. `$.process.run` takes `timeoutMs` up to 600000 (the default is 30 s). For long output, start `$.process.spawn({ argv, cwd })` from a detached async IIFE, read it with `for await`, then `await stream.result` for `{ code, signal }`.
3. Narrow a tool input before use, as in `typeof e.command === 'string'`, since under the engine's tsconfig it may be `unknown`. To read a tool's fields by name, annotate the event instead of casting it: `const input: Record<string, unknown> = e`. Where a cast is the only way, the line above it says why.
4. The engine's PATH is not the user's. Commands installed in `~/.local/bin` or `~/.hermes/node/bin` (uv, npm, node, forja, local-jev) run through the user's interactive shell as `[shell, '-ic', 'cmd args']`; `hostInfo` in check-gate finds the shell and the home folder. git, sh and awk are on the plain PATH.
5. One mod at a time holds the band above the prompt: the first hook that returns a tree wins, and check-gate takes it in any repo with a check. Return a tree only while the mod has something current to show, and `next(e)` the rest of the time. A pane, the status line or a toast fits most other cases.
6. A repo-bound mod finds the repo with `$.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })`, matches it by the root's basename or by a file only that repo has, and passes everything through with `next(e)` in any other repo.
7. A `turn.complete` hook returns early when `e.agentId !== undefined`, because that turn belongs to a subagent.

## Guards

A guard is a hook that refuses a tool call or asks the person first. Review every guard change against these rules.

- The guard fails closed on every path. When it can't tell (git fails, a file can't be read, a `$` call rejects), it refuses or asks. Wrap the hook so a throw refuses: `on(...).catch(($, e, next) => next.called ? next(e) : { deny: '...' })`, with the reason from `next.error?.message`. The wrapper only sees throws. A helper that catches its own error and returns `undefined` hands the decision back to its caller, which treats `undefined` as "can't tell" and refuses or asks.
- Each refusal path has a test. So does each dependency the guard reads: make it reject by returning `{ deny }` from its test hook, and assert that the tool call is refused.
- A message the model reads says what happened, why, and what to do next.
- The mod's README row and marketplace description name exactly what the code checks: which tools, which repos, which commands. They change in the same commit as the code.

## Tests

`claude plugin test plugins/<mod>` runs `tests/*.test.ts(x)` against the engine with nothing beneath the plugin. A test hook answers every `$` call the code makes and every engine event the test raises:

| Call or event | Test answer |
| --- | --- |
| `process.run` | `{ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }` |
| `process.spawn` | an async generator that yields `{ stream: 'stdout' as const, text }` and returns `{ value: { code: 0, signal: null } }` |
| `fs.exists`, `session.cwd` | `{ value: true }`, `{ value: '/repo' }` |
| `ui.status`, `ui.toast`, `ui.log` | `{ value: undefined }` |
| clock, store | `mock.clock(on, { now })`, `mock.store(on)` |
| `tool.call`, `turn.complete` | `{ result: {} }`, `{ text: '' }` |
| `command.register`, `ui.open` | `{ value: { command: 'x' } }`, `{ value: { isPlaced: true } }` |
| `session.start` | `(_, e) => ({ cwd: e.cwd })` |

- A test file registers one hook per event; a second `on('process.run')` fails the file. Put every case in one hook that dispatches over a world object, as check-gate's `tests/gate.test.tsx` does.
- To make a `$` call reject, return `{ deny: 'reason' }` from its test hook. A test hook that throws is skipped, and the plugin then sees no implementation at all.
- Raise events with `$.tool.call({ tool: 'Bash', command })`, `$.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })`, `$.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })` and `$.command.run(...)`. `await clock.settle()` lets detached work finish. A refused call comes back as `{ deny }` or `{ isError: true, text }`.
- Mount UI with `$.ui.mount({ plugin, component, surface, props, requestId? })` for each of `['terminal', 'desktop'] as const`. AbovePrompt props are `{ hasSurvey, isWorking, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} }`; Pane props are in the skill's `examples/pane.test.tsx`. Query and press with `ui.find({ type: 'Text', text: /re/ })`, `ui.find({ key })` and `ui.press({ key })`.
- Assert unconditionally. Check that a value exists with `expect(x).toBeDefined()` before asserting on it, so a missing value fails the test.

## Before you push

1. Bump `version` in the mod's `plugin.json` when its `hooks/` or `skills/` change. `claude plugin update` goes by that number, so with the same number installed copies keep the old code and the update reports "already at the latest version". To install the new version on this machine, run `claude plugin marketplace update andres-skills`, then `claude plugin update <mod>@andres-skills`.
2. Run `scripts/check-mods.sh`. It validates and tests every mod, or only the ones you name (`scripts/check-mods.sh check-gate boe-guard`), and fails a mod whose hooks or skills changed while its version didn't. CI runs the same script on each pull request and push to main that touches `plugins/`. It runs `claude plugin validate` without `--strict`, which would turn the missing plugin icon (ICON_MISSING) into an error.
3. Type-check with `npx -p typescript tsc -p plugins/<mod>`. The mod's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes (and git ignores) once it has loaded the mod from an install or a `--plugin-dir` session. Before that, the `plugin-authoring` skill says how to type-check against its types file. CI skips this step because those types only exist where the engine has loaded the mod.
4. When the mod parses a command's output, feed the parser real output and keep it as a fixture. Capture it from a command that only reads: a status or list command, `--help`, or a dry run. When the only command that produces the output spends money or changes something (a GPU rental, a push, a sent message), build the fixture from the tool's docs or ask the person for a sample.

## The pinned Claude Code version

The mod API changes between releases, so CI installs a fixed version, `@anthropic-ai/claude-code@2.1.317`, and the README names the version the mods were tested on. To move to a newer release, install it locally, run `scripts/check-mods.sh` and the type-check on it, fix what breaks, then change the version in `.github/workflows/mods.yml` and in the README in the same commit.
