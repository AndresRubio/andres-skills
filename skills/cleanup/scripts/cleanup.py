#!/usr/bin/env python3
"""Find and remove what a Claude Code session left behind.

Two steps, so nothing is deleted before a human has seen the plan:

    cleanup.py scan  --repo DIR [--scratchpad DIR] [--since ISO] [--branch NAME]... --out plan.json
    cleanup.py apply plan.json --ids ID,ID,... [--dry-run]

`scan` looks at one repository and one scratchpad and writes a plan: every
candidate gets an id, a verdict (safe, ask or keep) and the reason. It never
changes anything. `apply` runs the actions of the ids you pass and nothing
else. Run `scan` again afterwards to confirm the result.

Verdicts:
  safe  merged work, detached worktrees that only point at the base branch,
        the session scratchpad, worktree entries whose folder is already gone.
  ask   anything that would lose work: uncommitted changes, commits not on the
        base branch, remote branches, untracked files written this session.
  keep  never touched: the main checkout, the worktree this process runs in,
        worktrees not made by a session, untracked files older than the
        session.
"""

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys

WORKTREE_DIR = os.path.join(".claude", "worktrees")
SESSION_BRANCH_PREFIX = "claude/"


# ---------------------------------------------------------------- helpers


def run(cmd, cwd=None, check=False, timeout=60):
    """Run a command and return (returncode, stdout). Never raises on failure."""
    try:
        p = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=check
        )
        return p.returncode, p.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.CalledProcessError) as e:
        return 1, str(e)


def git(repo, *args, timeout=60):
    return run(["git", "-C", repo, *args], timeout=timeout)


def dir_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path, onerror=lambda e: None):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def real(path):
    return os.path.realpath(os.path.expanduser(path))


def is_within(path, parent):
    path, parent = real(path), real(parent)
    return path == parent or path.startswith(parent + os.sep)


# ---------------------------------------------------------------- git facts


def repo_root(path):
    code, out = git(path, "rev-parse", "--show-toplevel")
    return real(out) if code == 0 else None


def main_checkout(repo):
    """The primary worktree of the repository (where .git is a directory)."""
    code, out = git(repo, "rev-parse", "--git-common-dir")
    if code != 0:
        return repo
    common = out if os.path.isabs(out) else os.path.join(repo, out)
    return real(os.path.dirname(real(common)))


def base_branch(repo):
    code, out = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if code == 0 and out.startswith("origin/"):
        return out[len("origin/"):]
    for cand in ("main", "master", "develop"):
        if git(repo, "show-ref", "--verify", "--quiet", f"refs/heads/{cand}")[0] == 0:
            return cand
    code, out = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    return out if code == 0 else "main"


def base_ref(repo, base):
    """Prefer origin/<base> when it exists, so a local base that is behind does not hide merges."""
    if git(repo, "show-ref", "--verify", "--quiet", f"refs/remotes/origin/{base}")[0] == 0:
        return f"origin/{base}"
    return base


def is_ancestor(repo, commit, ref):
    return git(repo, "merge-base", "--is-ancestor", commit, ref)[0] == 0


def patches_on_base(repo, commit, ref):
    """True when every commit of `commit` not on `ref` has a patch-equivalent commit on `ref`
    (a squash or rebase merge). git cherry marks those with '-'; a '+' line means real new work."""
    code, out = git(repo, "cherry", ref, commit)
    if code != 0 or not out:
        return False
    return all(line.startswith("-") for line in out.splitlines() if line.strip())


def merge_state(repo, commit, ref, pr):
    """(merged, how) for a commit against the base ref, using the strongest evidence available."""
    if pr and pr.get("state") == "MERGED":
        return True, "PR merged"
    if is_ancestor(repo, commit, ref):
        return True, f"already on {ref}"
    if patches_on_base(repo, commit, ref):
        return True, f"every commit has a patch-equivalent on {ref} (squash or rebase merge)"
    return False, None


def ahead_count(repo, commit, ref):
    code, out = git(repo, "rev-list", "--count", f"{ref}..{commit}")
    return int(out) if code == 0 and out.isdigit() else -1


def dirty_count(worktree):
    code, out = git(worktree, "status", "--porcelain", "--untracked-files=all")
    if code != 0:
        return -1
    return len([l for l in out.splitlines() if l.strip()])


def worktrees(repo):
    code, out = git(repo, "worktree", "list", "--porcelain")
    if code != 0:
        return []
    result, cur = [], {}
    for line in out.splitlines() + [""]:
        if not line:
            if cur:
                result.append(cur)
            cur = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            cur["path"] = real(value)
        elif key == "HEAD":
            cur["head"] = value
        elif key == "branch":
            cur["branch"] = value.replace("refs/heads/", "")
        elif key == "detached":
            cur["detached"] = True
        elif key == "prunable":
            cur["prunable"] = value or True
        elif key == "bare":
            cur["bare"] = True
    return result


def local_branches(repo):
    code, out = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    return out.splitlines() if code == 0 else []


def remote_branch_exists(repo, branch):
    return git(repo, "show-ref", "--verify", "--quiet", f"refs/remotes/origin/{branch}")[0] == 0


def pr_state(repo, branch):
    """MERGED, OPEN, CLOSED, or None when gh is missing, offline, or there is no PR."""
    if shutil.which("gh") is None:
        return None
    code, out = run(
        ["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "1",
         "--json", "state,url,mergedAt"],
        cwd=repo, timeout=30,
    )
    if code != 0 or not out:
        return None
    try:
        prs = json.loads(out)
    except json.JSONDecodeError:
        return None
    if not prs:
        return None
    return {"state": prs[0].get("state"), "url": prs[0].get("url")}


# ---------------------------------------------------------------- scan


def scan(args):
    items = []
    plan = {"scanned_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"), "items": items}
    since = dt.datetime.fromisoformat(args.since).timestamp() if args.since else None
    extra_branches = set(args.branch or [])
    cwd = real(os.getcwd())

    repo = repo_root(args.repo) if args.repo else None
    if args.repo and repo is None:
        plan["repo"] = None
        plan["note"] = f"{args.repo} is not inside a git repository; only the scratchpad was scanned."
    if repo:
        main = main_checkout(repo)
        base = base_branch(main)
        if not args.no_fetch:
            git(main, "fetch", "--quiet", "--prune", "origin", timeout=90)
        bref = base_ref(main, base)
        plan.update({"repo": main, "base": base, "base_ref": bref, "cwd": cwd})
        handled_branches = set()
        wt_root = os.path.join(main, WORKTREE_DIR)

        for n, wt in enumerate(worktrees(main), 1):
            path = wt.get("path")
            if wt.get("bare") or path == main:
                continue
            item = {
                "id": f"wt{n}", "kind": "worktree", "path": path,
                "branch": wt.get("branch"), "detached": bool(wt.get("detached")),
                "head": (wt.get("head") or "")[:10], "actions": [],
            }
            branch = wt.get("branch")
            if branch:
                handled_branches.add(branch)
            if wt.get("prunable"):
                item.update(verdict="safe", reason="worktree folder is gone; only the git entry remains",
                            actions=[["git", "-C", main, "worktree", "prune"]])
                if branch and not is_ancestor(main, branch, bref):
                    item.update(verdict="ask", reason="folder is gone but its branch has commits not on "
                                f"{bref}; pruning keeps the branch, deleting it loses them")
                    item["actions"].append(["git", "-C", main, "branch", "-D", branch])
                items.append(item)
                continue
            item["bytes"] = dir_bytes(path)
            session_made = is_within(path, wt_root) or (branch in extra_branches)
            if is_within(cwd, path):
                item.update(verdict="keep", reason="this session is running inside it; leave it to "
                            "ExitWorktree or to the app when the session is archived")
                items.append(item)
                continue
            if not session_made:
                item.update(verdict="keep", reason="not under .claude/worktrees and not named with "
                            "--branch, so no session made it")
                items.append(item)
                continue
            dirty = dirty_count(path)
            item["dirty"] = dirty
            ahead = ahead_count(main, wt.get("head"), bref)
            item["ahead"] = ahead
            pr = pr_state(main, branch) if branch else None
            item["pr"] = pr
            merged, how = merge_state(main, wt.get("head"), bref, pr)
            item["merged"] = bool(merged)
            # Plain `remove` and `-d` refuse to lose work, so a SAFE item never needs force.
            # ASK items are where something is lost on purpose, with the user's yes.
            risky = dirty > 0 or not merged
            item["actions"].append(["git", "-C", main, "worktree", "remove"] + (["--force"] if risky else []) + [path])
            if branch:
                plain = not risky and is_ancestor(main, wt.get("head"), bref)
                item["actions"].append(["git", "-C", main, "branch", "-d" if plain else "-D", branch])
            if dirty > 0:
                item.update(verdict="ask", reason=f"{dirty} uncommitted change(s) would be lost")
            elif merged:
                what = "detached HEAD" if not branch else f"branch {branch}"
                item.update(verdict="safe", reason=f"{what}, {how}")
            else:
                prnote = f", PR {pr['state'].lower()}" if pr else ", no PR found"
                item.update(verdict="ask", reason=f"{ahead} commit(s) not on {bref}{prnote}")
            items.append(item)

        cur_code, cur = git(main, "rev-parse", "--abbrev-ref", "HEAD")
        for n, branch in enumerate(local_branches(main), 1):
            if branch in handled_branches or branch == base or (cur_code == 0 and branch == cur):
                continue
            if not (branch.startswith(SESSION_BRANCH_PREFIX) or branch in extra_branches):
                continue
            pr = pr_state(main, branch)
            merged, how = merge_state(main, branch, bref, pr)
            item = {
                "id": f"br{n}", "kind": "branch", "branch": branch, "pr": pr, "merged": bool(merged),
                "ahead": ahead_count(main, branch, bref),
                "actions": [["git", "-C", main, "branch",
                             "-d" if is_ancestor(main, branch, bref) else "-D", branch]],
            }
            if merged:
                item.update(verdict="safe", reason=f"local branch, {how}")
            else:
                prnote = f", PR {pr['state'].lower()}" if pr else ", no PR found"
                item.update(verdict="ask", reason=f"{item['ahead']} commit(s) not on {bref}{prnote}")
            items.append(item)
            handled_branches.add(branch)

        for n, branch in enumerate(sorted(handled_branches), 1):
            if remote_branch_exists(main, branch):
                owner = next((i for i in items if i.get("branch") == branch), None)
                items.append({
                    "id": f"rb{n}", "kind": "remote-branch", "branch": branch,
                    "verdict": "ask", "merged": bool(owner and owner.get("merged")),
                    "reason": ("origin/%s exists; merged, so deleting it is housekeeping" % branch)
                    if owner and owner.get("merged") else
                    ("origin/%s exists and still holds unmerged work" % branch),
                    "actions": [["git", "-C", main, "push", "origin", "--delete", branch]],
                })

        code, out = git(main, "status", "--porcelain", "--untracked-files=normal")
        for n, line in enumerate((out.splitlines() if code == 0 else []), 1):
            if not line.startswith("??"):
                continue
            rel = line[3:].strip().strip('"')
            if rel.startswith(WORKTREE_DIR + os.sep) or rel.rstrip("/") == WORKTREE_DIR:
                continue
            path = os.path.join(main, rel)
            if args.out and real(path) == real(args.out):
                continue
            try:
                mtime = os.lstat(path).st_mtime
            except OSError:
                continue
            item = {
                "id": f"uf{n}", "kind": "untracked", "path": path, "bytes": dir_bytes(path)
                if os.path.isdir(path) else os.lstat(path).st_size,
                "mtime": dt.datetime.fromtimestamp(mtime).isoformat(timespec="minutes"),
                "actions": [["rm", "-rf", path]],
            }
            if since is not None and mtime < since:
                item.update(verdict="keep", reason="untracked but older than this session")
            else:
                item.update(verdict="ask", reason="untracked file written during this session; "
                            "may be a deliverable")
            items.append(item)

    if args.scratchpad:
        sp = real(args.scratchpad)
        if os.path.isdir(sp):
            entries = sorted(e for e in os.listdir(sp)
                             if not (args.out and real(os.path.join(sp, e)) == real(args.out)))
            if entries:
                items.append({
                    "id": "sp", "kind": "scratchpad", "path": sp, "bytes": dir_bytes(sp),
                    "entries": len(entries), "verdict": "safe",
                    "reason": "session scratchpad; temporary by definition",
                    "actions": [["rm", "-rf", os.path.join(sp, e)] for e in entries],
                })
        plan["scratchpad"] = sp

    if args.out:
        with open(args.out, "w") as f:
            json.dump(plan, f, indent=2)
    print_plan(plan, args.out)
    return 0


def print_plan(plan, out_path=None):
    if plan.get("repo"):
        print(f"repo: {plan['repo']}  base: {plan['base_ref']}")
    elif plan.get("note"):
        print(plan["note"])
    if plan.get("scratchpad"):
        print(f"scratchpad: {plan['scratchpad']}")
    items = plan["items"]
    if not items:
        print("nothing left behind.")
        return
    for verdict in ("safe", "ask", "keep"):
        group = [i for i in items if i["verdict"] == verdict]
        if not group:
            continue
        print(f"\n{verdict.upper()} ({len(group)})")
        for i in group:
            what = i.get("path") or i.get("branch")
            if i["kind"] == "remote-branch":
                what = f"origin/{i['branch']}"
            size = f"  {human(i['bytes'])}" if "bytes" in i else ""
            extra = ""
            if i["kind"] == "worktree":
                extra = f"  [{i.get('branch') or 'detached'}]"
            print(f"  {i['id']:<5} {i['kind']:<14} {what}{extra}{size}")
            print(f"        {i['reason']}")
    if out_path:
        print(f"\nplan written to {out_path}")


# ---------------------------------------------------------------- apply


def apply(args):
    with open(args.plan) as f:
        plan = json.load(f)
    wanted = {s.strip() for s in args.ids.split(",") if s.strip()}
    by_id = {i["id"]: i for i in plan["items"]}
    unknown = wanted - set(by_id)
    if unknown:
        print(f"unknown ids: {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    failures = 0
    freed = 0
    for item_id in sorted(wanted, key=lambda x: (x[:2] != "wt", x)):
        item = by_id[item_id]
        if item["verdict"] == "keep":
            print(f"{item_id}: verdict is keep; refusing. Edit the plan if you really mean it.")
            failures += 1
            continue
        label = item.get("path") or item.get("branch")
        print(f"{item_id} {item['kind']} {label}")
        for cmd in item["actions"]:
            if cmd[0] == "rm":
                target = cmd[-1]
                if not (plan.get("repo") and is_within(target, plan["repo"])) and not (
                    plan.get("scratchpad") and is_within(target, plan["scratchpad"])
                ):
                    print(f"   refusing to delete outside repo or scratchpad: {target}")
                    failures += 1
                    continue
            shown = " ".join(cmd)
            if args.dry_run:
                print(f"   would run: {shown}")
                continue
            if cmd[0] == "rm":
                try:
                    if os.path.isdir(target) and not os.path.islink(target):
                        shutil.rmtree(target)
                    elif os.path.lexists(target):
                        os.remove(target)
                    print(f"   removed {target}")
                except OSError as e:
                    print(f"   FAILED {shown}: {e}")
                    failures += 1
                continue
            code, out = run(cmd, timeout=120)
            if code == 0:
                print(f"   ok: {shown}")
            else:
                print(f"   FAILED ({code}): {shown}\n      {out}")
                failures += 1
        if not args.dry_run:
            freed += item.get("bytes", 0)
    if not args.dry_run:
        print(f"\nfreed about {human(freed)}; {failures} failure(s)")
    return 1 if failures else 0


# ---------------------------------------------------------------- main


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan", help="list what the session left behind; changes nothing")
    s.add_argument("--repo", help="any path inside the repository (default: current directory)",
                   default=os.getcwd())
    s.add_argument("--no-repo", action="store_true", help="skip git entirely")
    s.add_argument("--scratchpad", help="the session's scratchpad directory")
    s.add_argument("--since", help="session start, ISO 8601; older untracked files are kept")
    s.add_argument("--branch", action="append",
                   help="a branch this session created (besides claude/*); repeatable")
    s.add_argument("--no-fetch", action="store_true", help="do not fetch origin first")
    s.add_argument("--out", help="where to write the plan JSON")
    s.set_defaults(func=scan)
    a = sub.add_parser("apply", help="run the actions of the chosen plan ids")
    a.add_argument("plan")
    a.add_argument("--ids", required=True, help="comma-separated ids from the plan")
    a.add_argument("--dry-run", action="store_true")
    a.set_defaults(func=apply)
    args = ap.parse_args(argv)
    if args.cmd == "scan" and args.no_repo:
        args.repo = None
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
