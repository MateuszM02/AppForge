#!/usr/bin/env python3
"""Offline tuning for the repo-finder skill's search.py (agensi/repo-finder) on tests/search-gold.json.

  python scripts/eval-repo-finder.py [--fetch] [--pool 2500] [--variants "base 3000:junk=true,prf_terms=12"]
                                     [--k 60,100,150,300] [--split even|odd|all]

--fetch runs every gold prompt's GitHub searches once (3 prompts at a time) with a large pool and saves the pools;
GitHub answers are cached by request, so a rerun costs no network. Without --fetch it only ranks the saved pools:
no network, no tokens. It reports, per variant, the share of gold repos (must + nice, per prompt, as upstream's
poolRecall) in the pool and in the top K printed lines, must-have recall, gold dropped by the junk filter and the
printed tokens (characters / 4). Tune on the even prompts; the odd ones are the hold-out.
Caches go to <data folder>/cache/eval/repo-finder/ (APPFORGE_HOME or the platform's AppForge folder).
"""
import argparse, hashlib, json, os, sys, types
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "agensi", "repo-finder", "skills", "find-repo", "scripts"))
import search  # noqa: E402


def data_dir():
    if os.environ.get("APPFORGE_HOME"):
        return os.path.abspath(os.environ["APPFORGE_HOME"])
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local"), "AppForge")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "AppForge")
    return os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"), "appforge")


CACHE = os.path.join(data_dir(), "cache", "eval", "repo-finder")
real_gh = search.gh


def cached_gh(args, body=None):
    key = hashlib.sha1(json.dumps([args, body]).encode()).hexdigest()
    f = os.path.join(CACHE, "gh", key + ".json")
    if os.path.exists(f):
        return json.load(open(f, encoding="utf-8"))
    out = real_gh(args, body)
    if out.get("data") or out.get("items") is not None:  # cache answers only, never errors
        json.dump(out, open(f, "w", encoding="utf-8"))
    return out


search.gh = cached_gh


def args_for(need, **kw):
    a = search.parser().parse_args([need])
    for k, v in kw.items():
        setattr(a, k, v)
    if not a.language:
        a.language = next((search.LANGUAGES[t] for t in search.re.findall(r"[\w+#]+", need.lower()) if t in search.LANGUAGES), None)
    return a


def fetch(i, item, pool):
    f = os.path.join(CACHE, "pools", f"{i:02d}.json")
    if os.path.exists(f):
        return
    a = args_for(item["prompt"], pool=pool)
    nodes, searches, topics = search.collect(a, search.extract_terms(item["prompt"]))
    json.dump({"prompt": item["prompt"], "pool": nodes, "searches": searches, "topics": topics}, open(f, "w", encoding="utf-8"))


def variant(spec):
    """"base" (today: pool 1500, search.py's settings) or "<pool>:key=value,key=value" overriding search.TUNE."""
    if spec == "base":  # the skill before model-free filtering
        return 1500, {"junk": False, "prf_terms": 0}
    pool, _, rest = spec.partition(":")
    tune = {}
    for kv in filter(None, rest.split(",")):
        k, v = kv.split("=")
        tune[k] = json.loads(v) if v not in ("true", "false") else v == "true"
    return int(pool), tune


def lines_of(item, nodes, limit, names, pool_size, tune):
    """The repos search.py would print and the characters it would print for them (full lines, then names only)."""
    a = args_for(item["prompt"], limit=limit, names=names)
    old = dict(search.TUNE)
    search.TUNE.update(tune)
    try:
        shown = search.select(nodes[:pool_size], search.extract_terms(item["prompt"]), a)
    finally:
        search.TUNE.clear(); search.TUNE.update(old)
    return [n["nameWithOwner"].lower() for n in shown], len(search.render(shown, limit))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--pool", type=int, default=2500)
    ap.add_argument("--variants", default="base", help='space-separated: base, or "<pool>:key=value,..." (search.TUNE)')
    ap.add_argument("--k", default="60,100,150,300")
    ap.add_argument("--names", type=int, default=0, help="of each K, this many shown as names only (0 = all full lines)")
    ap.add_argument("--split", default="even", choices=["even", "odd", "all"])
    a = ap.parse_args()
    os.makedirs(os.path.join(CACHE, "gh"), exist_ok=True)
    os.makedirs(os.path.join(CACHE, "pools"), exist_ok=True)
    gold = json.load(open(os.path.join(ROOT, "tests", "search-gold.json"), encoding="utf-8"))["prompts"]
    if a.fetch:
        with ThreadPoolExecutor(3) as ex:
            list(ex.map(lambda j: fetch(j, gold[j], a.pool), range(len(gold))))
    idx = [i for i in range(len(gold)) if a.split == "all" or (i % 2 == 0) == (a.split == "even")]
    ks = [int(k) for k in a.k.split(",")]
    print(f"{len(idx)} prompts ({a.split}); recall of gold (must+nice) per prompt; must = must-have recall")
    for v in a.variants.split():
        pool_size, tune = variant(v)
        rec = {k: [] for k in ks}; must = {k: [] for k in ks}; pool_r, chars, dropped = [], {k: [] for k in ks}, 0
        for i in idx:
            item = gold[i]
            nodes = json.load(open(os.path.join(CACHE, "pools", f"{i:02d}.json"), encoding="utf-8"))["pool"]
            g = {x.lower() for x in item["must_include"] + item["nice_to_have"]}; m = {x.lower() for x in item["must_include"]}
            names = {n["nameWithOwner"].lower() for n in nodes[:pool_size]}
            pool_r.append(len(g & names) / len(g))
            full, _ = lines_of(item, nodes, 10 ** 6, 0, pool_size, tune)
            dropped += len((g & names) - set(full))
            for k in ks:
                nm = a.names if v != "base" and k > a.names else 0
                shown, c = lines_of(item, nodes, k - nm, nm, pool_size, tune)
                s = set(shown)
                rec[k].append(len(g & s) / len(g)); must[k].append(len(m & s) / len(m)); chars[k].append(c)
        avg = lambda xs: sum(xs) / len(xs)
        print(f"{v[:40]:40s} pool {avg(pool_r):.3f} | " + " | ".join(
            f"@{k} {avg(rec[k]):.3f} must {avg(must[k]):.3f} ~{avg(chars[k]) / 4000:.1f}k tok" for k in ks) + f" | gold dropped {dropped}")


if __name__ == "__main__":
    main()
