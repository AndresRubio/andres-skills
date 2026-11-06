# andres-skills

Personal [Claude Code skills](https://code.claude.com/docs/en/skills).

| Skill | What it does |
|---|---|
| [`cleanup`](skills/cleanup/SKILL.md) | End-of-session cleanup: scans the current repository and the session scratchpad for what the session left behind (worktrees under `.claude/worktrees`, `claude/*` branches and their remote copies, untracked files, scratch files), shows a plan, removes the merged and temporary items, and asks per item before anything that still holds work goes. |
| [`confession-box`](skills/confession-box/SKILL.md) | Honest report of the shortcuts Claude took in a coding session: reads the session log and git diff, walks tests, type and lint suppressions, logic shortcuts, verification and scope drift, lists each confession with its evidence, and suggests `/retro` when a lint rule, hook or CI job could have caught one. |
| [`five-dysfunctions`](skills/five-dysfunctions/SKILL.md) | Lencioni's *The Five Dysfunctions of a Team* applied to Claude Code sessions and agent teams: live working norms, session audits (with a transcript condenser and signal scan), and multi-agent team design. Bilingual (EN/ES). |

## Plugins

| Plugin | What it does |
|---|---|
| [`claude-pipeline`](plugins/claude-pipeline/README.md) (SDLC-Forward) | Issue-to-PR pipeline for Claude Code: `/claude-pipeline:ship` takes a GitHub issue or a free-text idea through research, grade, spec, plan, build, verify, self-review and pull request, with a run guard hook that blocks pushes to the base branch and PR merges. Design in [`docs/superpowers/specs/`](plugins/claude-pipeline/docs/superpowers/specs/2026-09-24-claude-pipeline-design.md), status in [`docs/phase1-build-report.md`](plugins/claude-pipeline/docs/phase1-build-report.md). |

Install from the marketplace: `claude plugin marketplace add https://github.com/AndresRubio/andres-skills.git` then `claude plugin install claude-pipeline@andres-skills`. For development, `claude --plugin-dir plugins/<name>` still works.

## Mods

Mods are plugins whose TypeScript hooks module runs inside the Claude Code session: it can refuse or rewrite tool calls, add a slash command, and draw a pane, a band above the prompt, a status line entry or a toast. The exceptions are `humanizer` and `guards`, which use Python command hooks. Most of these are tied to one of my repos and do nothing anywhere else. They need a Claude Code version with mod support (tested on 2.1.317).

| Mod | Where it acts | What it does |
|---|---|---|
| [`check-gate`](plugins/check-gate/) | any repo with `scripts/check.sh` or a `check` script in `package.json` | Reruns the check in the background after a turn that changed code, shows the result above the prompt, and refuses `git commit` while the check fails in the repo the commit lands in. A commit on a tree with no result starts the check in the background and waits four seconds for it. A check that ends in that time settles the commit in the same call, as long as no file changed meanwhile. A check script that remembers the trees it has passed ends that fast on one of them. A longer check gets the commit refused, and the session gets a message when the check ends, so the commit is run again then instead of waiting inside the tool call. It follows `git -C`, `cd`, `pushd`, `if cd`, subshells, `$(...)`, `bash -c` and variables the command sets. It also refuses a commit when `git rev-parse` can't find that repo, or when the command's text doesn't settle which repo it is: `GIT_DIR`, `--git-dir`, `--work-tree`, `CDPATH`, `eval`, `env -C`, `command cd`, `chdir`, `time -p cd`, `cd -`, `popd`, `pushd` with no folder, a `cd` to a variable the command doesn't set, a `cd` with `HOME` unset or set in front of it, a `cd` that may not run, a `cd` in a block that has closed, in a pipeline or in the background, a commit inside a function, an operator split by a line continuation, or commits in two folders. `/check-gate` runs it now, `/check-gate log` shows the last output. |
| [`citation-guard`](plugins/citation-guard/) | warhammer | When an edit changes a points or stat value in the army data, tells the model to add a CITATIONS.md entry, and shows a toast at the end of the turn if it didn't. `/citation-guard` lists the changes still missing a citation. |
| [`boe-guard`](plugins/boe-guard/) | boe-agent | Refuses reads of PROGRESS.md and the plans folder without a line limit, and asks the person before a command that loads a month from BDNS or BOE. |
| [`forja-cost-guard`](plugins/forja-cost-guard/) | forja | Asks the person before `forja run --yes`, showing the GPU, the hourly price and the maximum cost. Shows the running cost above the prompt during a run, and reminds to run `forja cleanup` after exit code 3 or an interrupted run. |
| [`digest-guard`](plugins/digest-guard/) | ai-digest | Refuses writes under `site/` that carry a Gmail address or a mailbox link, refuses any MCP tool, from any connected server, whose action is a Gmail write such as `send_message`, `create_draft` or `label_message`, and runs `digest-routine/check-structure.py` before `git push`. |
| [`mcp-inspector`](plugins/mcp-inspector/) | mcp-lab | A pane listing each MCP tool call with its duration, JSON-RPC error code and the start of its result, with a toast when an email or phone number got past redaction. Keeps a prompt-to-tool log; `/mcp-inspector export <path>` writes it as JSONL. |
| [`jev-status`](plugins/jev-status/) | every session | Shows `local-jev: up` or `down` in the status line, checked every minute, with a toast when the server goes down. `/jev-start` starts the server, or prints the `launchctl` command to start it when a login agent manages it. |
| [`pipeline-pane`](plugins/pipeline-pane/) | any repo running claude-pipeline | A pane showing the current `/claude-pipeline:ship` run: the stage running and its time, finished stages, subagents and the last events, with a toast when the run ends. |
| [`humanizer`](plugins/humanizer/) | every session | Python command hooks, so it needs `python3`. Adds a reminder of the writing rules to each prompt and tells the model to rewrite tells it just wrote to a `.md`, `.markdown`, `.mdx`, `.txt` or `.rst` file. Refuses `git commit` and `gh pr create` or `edit` when the message, title or body has a strong tell. Refuses `git commit` when a line it would add to a prose file has any tell, counting the index, `-a`, paths named on the commit and an earlier `git add` in the same command, in the repo a `cd` or `git -C` leads to. It lets the commit through when git can't answer or the folder is a shell variable. Prefix the command with `HUMANIZER_OK=1` for a deliberate quotation. Shows the person any tells in the closing message of a turn. Checks English and Spanish, and skips files under `node_modules`, `.superpowers`, session scratchpads, `~/.claude/skills` and `~/.claude/hooks`, plus `~/.claude/CLAUDE.md` and this mod's own skill. Includes the `humanizer` rewriting skill, based on [blader/humanizer](https://github.com/blader/humanizer) (MIT). |
| [`guards`](plugins/guards/) | every session | Python command hooks, so it needs `python3`. One process checks each Bash command. It asks the person before a git command that throws away uncommitted work: `git checkout -- <path>`, `git checkout .`, `git checkout -f`, `git restore` unless only `--staged`, `git reset --hard`, `git clean -f` and `git switch -f` or `--discard-changes`. It refuses a test, lint, type-check or check run piped into a filter such as `tail`, `grep` or `tee`, unless the command reads `$pipestatus` or sets `pipefail`. It refuses a path under `/tmp`, `/private/tmp` or `/var/tmp` outside Claude Code's own `/tmp/claude-<uid>/` folder, in the command's words, in quoted code and in heredocs, and in the file a Write, Edit, MultiEdit or NotebookEdit writes. Prefix the command with `TMP_OK=1` when the path is wanted. It refuses `gh pr merge` when GitHub says the pull request's base is not the repository's default branch, when it can't read either, or when the text doesn't say which folder or repository the merge runs in. Prefix it with `MERGE_BASE_OK=1` to merge a stacked pull request into its parent. When several checks object, a refusal wins over a question and every reason is shown. |

Install one with `claude plugin install <mod>@andres-skills` once the marketplace is added. `scripts/check-mods.sh` validates and tests every mod, and CI runs it on each pull request and push to main that touches `plugins/`. [`docs/mods.md`](docs/mods.md) has the rules for changing or adding a mod and how to type-check one.

## Install

```bash
git clone https://github.com/AndresRubio/andres-skills.git
mkdir -p ~/.claude/skills
ln -s "$PWD/andres-skills/skills/five-dysfunctions" ~/.claude/skills/five-dysfunctions
ln -s "$PWD/andres-skills/skills/cleanup" ~/.claude/skills/cleanup
ln -s "$PWD/andres-skills/skills/confession-box" ~/.claude/skills/confession-box
```

Claude Code picks up skills in `~/.claude/skills/` automatically.

## Evals

Each skill keeps its eval prompts and fixtures in `evals/`. See [`skills/five-dysfunctions/evals/README.md`](skills/five-dysfunctions/evals/README.md).
