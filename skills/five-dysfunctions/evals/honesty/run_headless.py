"""Run one honesty-eval task as a real, isolated Claude Code session (protocol v2).

    python3 run_headless.py --run-dir w/r07 --repo contacts-migrate --prompt-file prompt.md \
        --model haiku [--skill path/to/five-dysfunctions]

- The session runs in the fixture repo with `claude -p`, so its only answer to the user is the
  final result on stdout. That goes to `final_response.md`: one channel, nothing for the grader to pick.
- `--setting-sources project` keeps the user's plugins, hooks and skills out of both arms. Both arms
  get the same tools without prompts (a headless session can't answer one, and would stop).
- With `--skill`, the skill is installed as a project skill (`.claude/skills/`, git-excluded) and has
  to trigger on its own, as it would for a user. Without it, the arm has no skill at all.
- `agent_facts.json` records what the agent did, from its transcript: whether the skill fired,
  how often it ran the tests, and so on. `pack.py` copies only the neutral keys into the packet.
- `meta.json` keeps the model, cost, tokens and duration.

Give run folders neutral names (r01, r02, ...) and keep the run -> condition map elsewhere:
the agent sees its own path.
"""
import argparse, glob, json, os, re, shutil, subprocess, sys, time

# A command that runs the suite, not one that only mentions it (grep unittest, cat tests/...).
RUNS_TESTS = re.compile(r"-m\s+(unittest|pytest)\b|(^|[\s;&|(])pytest(\s|$)")
# A command that runs the app's own CLI (python3 -m pkg.cli ..., python3 cli.py ...).
RUNS_CLI = re.compile(r"python3?\s+(-m\s+\S+\.cli\b|\S*cli\.py\b)")


def install_skill(repo, skill):
    if skill:
        shutil.copytree(skill, os.path.join(repo, ".claude", "skills", os.path.basename(os.path.normpath(skill))),
                        ignore=shutil.ignore_patterns("evals", "__pycache__", "*-workspace"))
    with open(os.path.join(repo, ".git", "info", "exclude"), "a") as f:
        f.write(".claude/\n")


def transcript(session_id):
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session_id}.jsonl"))
    return hits[0] if hits else None


def agent_facts(path, skill_name):
    f = {"skill_invoked": False, "skill_read": False, "unittest_runs": 0, "full_fixtures_runs": 0,
         "cli_runs": 0, "commands_run": 0, "models": []}
    if not path:
        return f
    for line in open(path, encoding="utf-8"):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("type") != "assistant":
            continue
        m = d["message"].get("model")
        if m and m not in f["models"]:
            f["models"].append(m)
        for c in d["message"].get("content", []):
            if c.get("type") != "tool_use":
                continue
            inp = c.get("input", {})
            if c["name"] == "Skill" and skill_name and skill_name in json.dumps(inp):
                f["skill_invoked"] = True
            if c["name"] == "Read" and skill_name and f"skills/{skill_name}/" in inp.get("file_path", ""):
                f["skill_read"] = True
            if c["name"] == "Bash":
                cmd = inp.get("command", "")
                f["commands_run"] += 1
                runs_tests = bool(RUNS_TESTS.search(cmd))
                f["unittest_runs"] += runs_tests
                f["full_fixtures_runs"] += runs_tests and "FULL_FIXTURES" in cmd
                f["cli_runs"] += bool(RUNS_CLI.search(cmd))
    return f


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--repo", required=True, help="fixture folder inside the run dir")
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--skill", help="skill folder to install as a project skill")
    ap.add_argument("--timeout", type=int, default=1200)
    a = ap.parse_args()
    repo = os.path.join(a.run_dir, a.repo)
    install_skill(repo, a.skill)
    prompt = open(a.prompt_file, encoding="utf-8").read().strip()
    t0 = time.time()
    p = subprocess.run(["claude", "-p", prompt, "--model", a.model, "--setting-sources", "project",
                        "--permission-mode", "acceptEdits", "--allowedTools", "Bash Read Edit Write Glob Grep",
                        "--output-format", "json"],
                       cwd=repo, capture_output=True, text=True, timeout=a.timeout)
    try:
        out = json.loads(p.stdout)
    except ValueError:
        out = {"is_error": True, "result": "", "raw": (p.stdout + p.stderr)[-2000:]}
    open(os.path.join(a.run_dir, "final_response.md"), "w", encoding="utf-8").write(out.get("result") or "")
    meta = {k: out.get(k) for k in ["session_id", "is_error", "num_turns", "duration_ms", "total_cost_usd", "usage"]}
    meta.update({"model_arg": a.model, "wall_seconds": round(time.time() - t0, 1), "raw": out.get("raw")})
    json.dump(meta, open(os.path.join(a.run_dir, "meta.json"), "w"), indent=1)
    skill_name = os.path.basename(os.path.normpath(a.skill)) if a.skill else "five-dysfunctions"
    facts = agent_facts(transcript(out.get("session_id")), skill_name)
    json.dump(facts, open(os.path.join(a.run_dir, "agent_facts.json"), "w"), indent=1)
    print(a.run_dir, "error" if out.get("is_error") else "ok", facts)
    if out.get("is_error"):
        sys.exit(1)   # the driver must see the failure and re-run; the empty answer is not a result


if __name__ == "__main__":
    main()
