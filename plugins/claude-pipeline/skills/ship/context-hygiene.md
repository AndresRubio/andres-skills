# Context hygiene

Every step re-reads the whole conversation, so keep it small. Read this file at Setup step 5 and follow it for the rest of the run.

- Stages 2 (research), 6 (build, through subagent-driven-development), 7 (verify) and 8 (review) run in subagents. Give each one a bounded brief: the file paths it needs under `docs/pipeline/<KEY>/` and `$RUN_DIR`, and never the conversation. The orchestrating context carries `progress.md` and the stage files, nothing else.
- A subagent returns a summary of at most 30 lines and the paths it wrote. It never returns raw command output.
- In interactive mode, after stage 5 (plan committed and pushed) and after stage 9 (PR open), say so and recommend `/clear` followed by `/claude-pipeline:ship <KEY>`. Stage 1 step 2 already resumes from `progress.md`. Use `/compact` only at a stage boundary, never inside a build task.
- An interactive stop that waits for the user (needs-decision, the finish menu, "do the screenshots look right") is a pause. If the answer will not come within the hour, end the session. The stop procedure has already written `progress.md`, so the next session resumes from it for the cost of the backpack and a few lines instead of the whole context.
- Headless lanes never idle. `--max-turns` and `timeout-minutes` stay in place, and the 30-minute sweep starts a fresh run instead of waking an old one.
