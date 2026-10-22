---
tags: [cleanup]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash, AskUserQuestion]
---

ok the report work is done for today, clean up what this session left behind. The project is at ./fixture/demo-app and this session's scratchpad directory is ./fixture/scratchpad (treat it exactly like the scratchpad the system prompt would name). I started this session about an hour ago.

Two things I already know: the wip-report worktree I still need, keep it as it is. Everything that's already merged can go, including its copy on origin. The tmp-output.log and the cleanup-workspace folder are junk from my test runs, delete them.
