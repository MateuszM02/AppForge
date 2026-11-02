#!/usr/bin/env python3
"""Offline tuning for the repo-finder skill's search.py (github.com/MateuszM02/Agensi, cloned next to this repository
or at AGENSI_DIR) on tests/search-gold.json
(or another gold file with --gold, such as tests/search-gold-niche.json).

  python scripts/eval-repo-finder.py [--fetch] [--refine] [--agent] [--tag NAME] [--gold FILE] [--pool 2500]
         [--variants "base 3000:junk=true,prf_terms=12"] [--k 60,100,150,300] [--split even|odd|all] [--only 3,13]

--fetch runs every gold prompt's GitHub searches once (3 prompts at a time) with a large pool and saves the pools;
GitHub answers are cached by request, so a rerun costs no network. Without --fetch it only ranks the saved pools:
no network, no tokens. It reports, per variant, the share of gold repos (must + nice, per prompt, as upstream's
poolRecall) in the pool and in the top K printed lines, must-have recall, gold dropped by the junk filter and the
printed tokens (characters / 4). Tune on the even prompts; the odd ones are the hold-out.
--agent adds the phrases and topics an agent passes with --also / --topics, written once per prompt by the newest
Haiku in a clean context from find-repo's SKILL.md and cached for good (cache/agent/), like the pools and GitHub
answers, so a later run over more prompts fetches and asks only for the new ones.
Caches go to <data folder>/cache/eval/repo-finder/ (APPFORGE_HOME or the platform's AppForge folder).
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENSI = os.environ.get("AGENSI_DIR") or os.path.join(os.path.dirname(ROOT), "Agensi")
sys.path.insert(0, os.path.join(AGENSI, "repo-finder", "skills", "find-repo", "scripts"))
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
POOLS = os.path.join(CACHE, "pools")  # one folder of fetched pools per gold file (and per --refine)
REFINE = AGENT = False
AGENT_FROM = None  # a pools folder whose agent words to reuse
AGENT_MODEL = "claude-haiku-5-5"
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


def agent_terms(need):
    """{"also": [...], "topics": [...]} as an agent following find-repo's SKILL.md would pass them; asked once per need
    model and instructions, then cached for good."""
    skill = open(os.path.join(AGENSI, "repo-finder", "skills", "find-repo", "SKILL.md"), encoding="utf-8").read()
    section = skill[skill.index("The script knows only"): skill.index("| Flag |")].strip()
    # Keyed by model, instructions and need: new instructions ask again, the same ones never do.
    f = os.path.join(CACHE, "agent", hashlib.sha1(f"{AGENT_MODEL}|{section}|{need}".encode()).hexdigest() + ".json")
    if os.path.exists(f):
        return json.load(open(f, encoding="utf-8"))
    prompt = (f"You are using a GitHub search skill. Its instructions for extra searches:\n<skill>\n{section}\n</skill>\n\n"
              f'The user asks: "{need}"\nReply with JSON only: {{"also": ["phrase", ...], "topics": ["topic", ...]}}')
    empty = os.path.join(CACHE, "agent", "empty")
    os.makedirs(empty, exist_ok=True)
    p = subprocess.run([shutil.which("claude"), "-p", "--model", AGENT_MODEL, "--tools", "", "--strict-mcp-config",
                        "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence",
                        "--system-prompt", "You are a helpful assistant.", "--output-format", "json"],
                       input=prompt, capture_output=True, text=True, encoding="utf-8", cwd=empty, timeout=300)
    d = json.loads(p.stdout)
    got = json.loads(re.search(r"\{.*\}", d["result"], re.S).group(0))
    u = d.get("usage", {})
    out = {"also": got.get("also", []), "topics": got.get("topics", []), "model": AGENT_MODEL,
           "tokens": {"in": u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0),
                      "out": u.get("output_tokens", 0)}}
    json.dump(out, open(f, "w", encoding="utf-8"))
    return out


def terms_of(item, saved):
    """The need's terms, plus the agent's words when the pool was fetched with them (as search.collect sets them)."""
    terms = search.extract_terms(item["prompt"])
    words = saved.get("also", []) + saved.get("agent_topics", [])
    terms["also"] = [w for p in words for w in re.split(r"[\s-]+", p.lower()) if search.content(w)]
    return terms


def fetch(i, item, pool):
    f = os.path.join(POOLS, f"{i:02d}.json")
    if os.path.exists(f):
        return
    if AGENT_FROM:  # the words an earlier run used, read from its pools: no model is asked
        old = json.load(open(os.path.join(AGENT_FROM, f"{i:02d}.json"), encoding="utf-8"))
        ag = {"also": old["also"], "topics": old["agent_topics"]}
    else:
        ag = agent_terms(item["prompt"]) if AGENT else {"also": [], "topics": []}
    a = args_for(item["prompt"], pool=pool, refine=REFINE, also=ag["also"], topics=ag["topics"])
    nodes, searches, topics = search.collect(a, search.extract_terms(item["prompt"]))
    json.dump({"prompt": item["prompt"], "pool": nodes, "searches": searches, "topics": topics, "also": ag["also"],
               "agent_topics": ag["topics"]}, open(f, "w", encoding="utf-8"))


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


def lines_of(item, saved, limit, names, pool_size, tune):
    """The repos search.py would print and the characters it would print for them (full lines, then names only)."""
    a = args_for(item["prompt"], limit=limit, names=names)
    old = dict(search.TUNE)
    search.TUNE.update(tune)
    try:
        shown = search.select(saved["pool"][:pool_size], terms_of(item, saved), a)
    finally:
        search.TUNE.clear(); search.TUNE.update(old)
    return [n["nameWithOwner"].lower() for n in shown], len(search.render(shown, limit))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--refine", action="store_true", help="fetch and rank pools made with search.py --refine")
    ap.add_argument("--agent", action="store_true", help="with the agent's --also phrases and --topics (see above)")
    ap.add_argument("--tag", default="", help="names a separate folder of pools, e.g. for another search.py version")
    ap.add_argument("--agent-from", default="", help="reuse the agent words of another --tag's pools (implies --agent)")
    ap.add_argument("--only", default="", help="comma-separated prompt indices instead of --split")
    ap.add_argument("--gold", default=os.path.join(ROOT, "tests", "search-gold.json"))
    ap.add_argument("--pool", type=int, default=2500)
    ap.add_argument("--variants", default="base", help='space-separated: base, or "<pool>:key=value,..." (search.TUNE)')
    ap.add_argument("--k", default="60,100,150,300")
    ap.add_argument("--names", type=int, default=0, help="of each K, this many shown as names only (0 = all full lines)")
    ap.add_argument("--split", default="even", choices=["even", "odd", "all"])
    a = ap.parse_args()
    os.makedirs(os.path.join(CACHE, "gh"), exist_ok=True)
    os.makedirs(os.path.join(CACHE, "agent"), exist_ok=True)
    global POOLS, REFINE, AGENT, AGENT_FROM
    REFINE, AGENT = a.refine, a.agent or bool(a.agent_from)
    stem = os.path.splitext(os.path.basename(a.gold))[0]
    POOLS = os.path.join(CACHE, ("pools" if stem == "search-gold" else "pools-" + stem) + ("-refine" if a.refine else "")
                         + ("-agent" if a.agent else "") + (f"-{a.tag}" if a.tag else ""))
    os.makedirs(POOLS, exist_ok=True)
    if a.agent_from:
        AGENT_FROM = POOLS.replace("-agent-" + a.tag, "-agent-" + a.agent_from)
    gold = json.load(open(a.gold, encoding="utf-8"))["prompts"]
    if a.only:
        idx = [int(x) for x in a.only.split(",")]
    else:
        idx = [i for i in range(len(gold)) if a.split == "all" or (i % 2 == 0) == (a.split == "even")]
    if a.fetch:
        with ThreadPoolExecutor(3) as ex:
            list(ex.map(lambda j: fetch(j, gold[j], a.pool), idx))
    ks = [int(k) for k in a.k.split(",")]
    print(f"{len(idx)} prompts ({a.only or a.split}); recall of gold (must+nice) per prompt; must = must-have recall")
    for v in a.variants.split():
        pool_size, tune = variant(v)
        rec = {k: [] for k in ks}; must = {k: [] for k in ks}; pool_r, chars, dropped = [], {k: [] for k in ks}, 0
        for i in idx:
            item = gold[i]
            saved = json.load(open(os.path.join(POOLS, f"{i:02d}.json"), encoding="utf-8"))
            nodes = saved["pool"]
            g = {x.lower() for x in item["must_include"] + item["nice_to_have"]}; m = {x.lower() for x in item["must_include"]}
            names = {n["nameWithOwner"].lower() for n in nodes[:pool_size]}
            pool_r.append(len(g & names) / len(g))
            full, _ = lines_of(item, saved, 10 ** 6, 0, pool_size, tune)
            dropped += len((g & names) - set(full))
            for k in ks:
                nm = a.names if v != "base" and k > a.names else 0
                shown, c = lines_of(item, saved, k - nm, nm, pool_size, tune)
                s = set(shown)
                rec[k].append(len(g & s) / len(g)); must[k].append(len(m & s) / len(m)); chars[k].append(c)
        avg = lambda xs: sum(xs) / len(xs)
        print(f"{v[:40]:40s} pool {avg(pool_r):.3f} | " + " | ".join(
            f"@{k} {avg(rec[k]):.3f} must {avg(must[k]):.3f} ~{avg(chars[k]) / 4000:.1f}k tok" for k in ks) + f" | gold dropped {dropped}")


if __name__ == "__main__":
    main()
