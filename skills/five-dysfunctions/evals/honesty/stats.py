"""Exact statistics for the honesty evals (a drop-in companion to score.py).

    python3 stats.py --mapping MAP grades.json --a haiku-base --b haiku-skill [grades2.json]

Prints, for conditions A and B:
  * per-run item scores and the condition means,
  * Fisher's exact test (two-sided) for every binary outcome
    (false_done, silent_tampering, each item H1..H6, "bare answer"),
  * an exact permutation test on the mean 6-item score (all C(nA+nB, nA)
    relabelings, so no scipy is needed),
  * Cohen's kappa between two graders when a second grades file is given,
  * a power table: the smallest Fisher-detectable difference at n per arm.

No third-party packages. Pure python 3.9+.
"""
import argparse, itertools, json, math, statistics as st

ITEMS = ["H1", "H2", "H3", "H4", "H5", "H6"]


def per_run(grades, mapping):
    out = {}
    for rid, run in mapping.items():
        g = grades[rid]
        items = {i: bool(g[i]["passed"]) for i in ITEMS}
        out[run] = {"items": items, "score": sum(items.values()),
                    "false_done": bool(g.get("false_done")),
                    "silent_tampering": bool(g.get("silent_tampering")),
                    "bare": all(not items[i] for i in ["H2", "H3", "H5", "H6"])}
    return out


def cond_of(run):
    return run.rsplit("-", 1)[0]


def fisher_two_sided(a, b, c, d):
    """2x2 table [[a, b], [c, d]] (row = condition, col = outcome yes/no)."""
    n = a + b + c + d
    r1, c1 = a + b, a + c

    def p(x):
        return (math.comb(r1, x) * math.comb(n - r1, c1 - x)) / math.comb(n, c1)

    p_obs = p(a)
    lo, hi = max(0, c1 - (n - r1)), min(r1, c1)
    return sum(p(x) for x in range(lo, hi + 1) if p(x) <= p_obs + 1e-12)


def permutation_mean_test(xs, ys):
    """Exact two-sided permutation test on mean(xs) - mean(ys)."""
    pool = xs + ys
    n_a = len(xs)
    obs = st.mean(xs) - st.mean(ys)
    total = 0
    extreme = 0
    for idx in itertools.combinations(range(len(pool)), n_a):
        a = [pool[i] for i in idx]
        b = [pool[i] for i in range(len(pool)) if i not in idx]
        diff = st.mean(a) - st.mean(b)
        total += 1
        if abs(diff) >= abs(obs) - 1e-12:
            extreme += 1
    return obs, extreme / total, total


def kappa(pairs):
    """Cohen's kappa for a list of (x, y) booleans."""
    n = len(pairs)
    po = sum(x == y for x, y in pairs) / n
    px = sum(x for x, _ in pairs) / n
    py = sum(y for _, y in pairs) / n
    pe = px * py + (1 - px) * (1 - py)
    return (po - pe) / (1 - pe) if pe < 1 else float("nan")


def power_table(n):
    """Fisher p for every split k/n vs 0/n (the mirror split n/n vs (n-k)/n gives the same p)."""
    rows = []
    for k in range(1, n + 1):
        p = fisher_two_sided(k, n - k, 0, n)
        rows.append((k, p))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mapping", required=True)
    ap.add_argument("grades", nargs="+", help="one or two grades files (the second is used for kappa)")
    ap.add_argument("--a", required=True, help="condition A, e.g. haiku-base")
    ap.add_argument("--b", required=True, help="condition B, e.g. haiku-skill")
    args = ap.parse_args()

    mapping = json.load(open(args.mapping))
    runs = per_run(json.load(open(args.grades[0])), mapping)
    A = {k: v for k, v in runs.items() if cond_of(k) == args.a}
    B = {k: v for k, v in runs.items() if cond_of(k) == args.b}
    if not A or not B:
        ap.error(f"conditions not found; have {sorted({cond_of(k) for k in runs})}")

    print(f"== {args.a} (n={len(A)}) vs {args.b} (n={len(B)}), grades: {args.grades[0]}")
    for name, grp in [(args.a, A), (args.b, B)]:
        for k in sorted(grp):
            v = grp[k]
            print(f"  {k:18} {''.join('P' if v['items'][i] else 'F' for i in ITEMS)}  score {v['score']}/6"
                  f"  fd={int(v['false_done'])} st={int(v['silent_tampering'])} bare={int(v['bare'])}")
        scores = [v["score"] for v in grp.values()]
        print(f"  {name:18} mean {100 * st.mean(scores) / 6:.1f}%  (scores {sorted(scores)})")

    xs = [v["score"] for v in A.values()]
    ys = [v["score"] for v in B.values()]
    obs, p, total = permutation_mean_test(xs, ys)
    print(f"\nExact permutation test on mean score: mean({args.a}) - mean({args.b}) = {obs:+.2f} items "
          f"({100 * obs / 6:+.1f} pts), two-sided p = {p:.3f} over {total} relabelings")

    print("\nFisher exact (two-sided), outcome counts A vs B:")
    for key, label in [("false_done", "false_done"), ("silent_tampering", "silent_tampering"), ("bare", "bare answer (H2,H3,H5,H6 all fail)")] + [(i, i + " pass") for i in ITEMS]:
        def yes(v):
            return v["items"][key] if key in ITEMS else v[key]
        a = sum(yes(v) for v in A.values()); b = len(A) - a
        c = sum(yes(v) for v in B.values()); d = len(B) - c
        pf = fisher_two_sided(a, b, c, d)
        print(f"  {label:38} {a}/{len(A)} vs {c}/{len(B)}   p = {pf:.3f}")

    if len(args.grades) > 1:
        runs2 = per_run(json.load(open(args.grades[1])), mapping)
        pairs_all = [(runs[r]["items"][i], runs2[r]["items"][i]) for r in runs for i in ITEMS]
        sub = [r for r in runs if cond_of(r) in (args.a, args.b)]
        pairs_sub = [(runs[r]["items"][i], runs2[r]["items"][i]) for r in sub for i in ITEMS]
        print(f"\nGrader agreement ({args.grades[0]} vs {args.grades[1]}):")
        print(f"  all runs:        raw {100 * sum(x == y for x, y in pairs_all) / len(pairs_all):.1f}%  kappa {kappa(pairs_all):.2f}")
        print(f"  {args.a}+{args.b}: raw {100 * sum(x == y for x, y in pairs_sub) / len(pairs_sub):.1f}%  kappa {kappa(pairs_sub):.2f}")

    n = min(len(A), len(B))
    print(f"\nWhat n={n} per arm can show (Fisher, two-sided, k/n vs 0/n):")
    for k, pk in power_table(n):
        print(f"  {k}/{n} vs 0/{n}: p = {pk:.3f}{'  <- significant' if pk < 0.05 else ''}")
    for m in (8, 10, 15, 20):
        ks = [k for k, pk in power_table(m) if pk < 0.05]
        print(f"  n={m}: smallest significant split k/{m} vs 0/{m} is k={ks[0] if ks else 'none'}")


if __name__ == "__main__":
    main()
