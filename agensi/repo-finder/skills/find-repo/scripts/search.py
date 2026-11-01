#!/usr/bin/env python3
"""Search GitHub for open-source projects that do what a need describes, and print 300 candidates for the agent to
judge. Python 3.8+ standard library only; GitHub access goes through the GitHub CLI (run `gh auth login` once).

  python search.py "self-hosted alternative to Notion" [--language Go] [--license MIT] [--min-stars 50]
                   [--pushed-within 365] [--limit 100] [--names 200] [--pool 1000]

The need becomes 6-15 GitHub searches, plus a second round on topics the best matches share; lists and tutorials are
dropped and the rest ranked by word match, GitHub's order and popularity.
"""
import argparse, base64, datetime, json, math, re, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

STOPWORDS = set("""a an and are as at be but by can do for from has have how i if in into is it its me my need no not of
on or our please should so some that the this to up use using want we what which with would you your also any best good
great new looking recommend suggest alternative alternatives open source opensource github repo repository project
something like way lets let help want wants i'm im""".split())
# Words every repository could use; searching on them only adds noise.
GENERIC = set("""app apps application tool tools software program utility service platform solution system convert
converts converter conversion find get simple easy free file files document documents data basic small lightweight
fast modern powerful awesome working support keep keeps track tracking manage managing nice best large medium big
category categories run running build building make making work works own my""".split())
# Kinds of project, platforms and languages narrow a search but never anchor one ("library sort:stars" is react).
ROLE = set("""library framework package module sdk toolkit component engine wrapper binding cli gui web desktop mobile
android ios linux windows macos self-hosted local locally cloud api plugin extension browser server python javascript
typescript java go rust""".split())
LANGUAGES = {"python": "python", "javascript": "javascript", "typescript": "typescript", "java": "java", "go": "go",
             "golang": "go", "rust": "rust", "kotlin": "kotlin", "swift": "swift", "ruby": "ruby", "php": "php",
             "c#": "c#", "csharp": "c#", "c++": "c++", "cpp": "c++", "dart": "dart", "elixir": "elixir",
             "scala": "scala", "haskell": "haskell", "lua": "lua", "zig": "zig"}
SYNONYMS = {"txt": ["text", "txt"], "text": ["text", "txt"], "word": ["docx", "word"], "doc": ["docx", "doc"],
            "excel": ["xlsx", "excel"], "xls": ["xlsx", "xls"], "powerpoint": ["pptx", "powerpoint"],
            "ppt": ["pptx", "ppt"], "image": ["image", "png"], "photo": ["photo", "image"], "jpeg": ["jpg", "jpeg"],
            "video": ["video", "mp4"], "movie": ["video", "movie"], "audio": ["audio", "mp3"], "music": ["music", "audio"],
            "ebook": ["ebook", "epub"], "md": ["markdown"], "email": ["email", "mail"], "k8s": ["kubernetes"],
            "db": ["database"], "todo": ["todo", "task"], "scrape": ["scraping", "scraper"],
            "scraping": ["scraper", "scraping"], "scraper": ["scraper", "scraping"], "crawl": ["crawler", "crawling"],
            "llms": ["llm"], "ai": ["ai", "llm"], "ads": ["ads", "adblock", "ad", "advertisement"],
            "ad": ["ad", "adblock", "ads", "advertisement"]}
NOISE_TOPICS = {"hacktoberfest", "awesome", "awesome-list", "list", "open-source", "opensource", "github", "free",
                "tool", "tools", "app", "application"}
# Topics on hundreds of thousands of repos: searched alone they bring in famous projects of every kind.
BROAD_TOPICS = set("""ai react reactjs vue nextjs nodejs node docker kubernetes-native machine-learning deep-learning
artificial-intelligence ml nlp llm llms gpt chatgpt openai javascript typescript python golang java rust cpp c csharp
php ruby swift kotlin android ios linux windows macos web webapp website frontend backend fullstack api rest
database sql json cli terminal gui desktop mobile self-hosted selfhosted docker-compose huggingface hacktoberfest2020
tutorial example examples template boilerplate starter""".split())


def singular(w):
    if len(w) <= 3 or re.search(r"(ss|us|is|os|ows)$", w) or w == "kubernetes":
        return w
    if w.endswith("ies"):
        return w[:-3] + "y"
    if re.search(r"(sses|xes|ches|shes)$", w):
        return w[:-2]
    return w[:-1] if w.endswith("s") else w


def content(t):
    return t != "|" and len(t) > 1 and t not in STOPWORDS and t not in GENERIC and singular(t) not in GENERIC


def extract_terms(need):
    """Concepts (spellings, most specific first), keywords, "X to Y" and two-word phrases, x2y names."""
    low = re.sub(r"[/,;&]+|\bor\b|\band\b", " | ", need.lower())
    tokens = [t if t == "|" else singular(t.strip(".-")) for t in re.findall(r"[\w+#.-]+|\|", low)]
    tokens = [t for t in tokens if t]
    concepts = {}
    for t in tokens:
        if content(t) and not any(t in v for v in concepts.values()):
            concepts[t] = SYNONYMS.get(t, [t])
    phrases, names = [], []
    converts = re.search(r"\bconver(t|ts|ter|sion)\b", need.lower())
    for i, t in enumerate(tokens):
        if t in ("to", "into") and i > 0 and content(tokens[i - 1]):
            src = concepts.get(tokens[i - 1], [tokens[i - 1]])[0]
            for j in range(i + 1, len(tokens)):
                if tokens[j] == "|":
                    continue
                if not content(tokens[j]):
                    break
                for dst in concepts.get(tokens[j], [tokens[j]]):
                    phrases.append(f"{src} to {dst}")
                    if len(src) <= 6 and len(dst) <= 6:
                        names.append(f"{src}2{dst}")
                if j + 1 >= len(tokens) or tokens[j + 1] != "|":
                    break
            if converts:
                phrases.append(f"{src} converter")
        if i + 1 < len(tokens) and content(t) and content(tokens[i + 1]) and t != tokens[i + 1]:
            phrases.append(f"{t} {tokens[i + 1]}")
    ranked = sorted(concepts.items(), key=lambda kv: kv[0] in ROLE)
    return {"concepts": [v for _, v in ranked], "keywords": [v[0] for _, v in ranked],
            "phrases": list(dict.fromkeys(phrases)), "names": list(dict.fromkeys(names))}


def qualifiers(a):
    q = ["archived:false"]
    lang = (a.language or "").strip().lower()
    if lang:
        q += [f'language:"{l}"' for l in (["javascript", "typescript"] if lang == "javascript" else [lang])]
    q += [f"license:{l.strip().lower()}" for l in (a.license or [])]
    if a.min_stars:
        q.append(f"stars:>={a.min_stars}")
    if a.pushed_within:
        q.append("pushed:>=" + (datetime.date.today() - datetime.timedelta(days=a.pushed_within)).isoformat())
    return " ".join(q)


def build_queries(need, terms, a):
    lang = (a.language or "").lower()
    concepts = [c for c in terms["concepts"] if not (lang and LANGUAGES.get(c[0]) == lang)]
    if not concepts:
        return []
    anchor, others = concepts[0], concepts[1:]
    alt = lambda xs: " OR ".join(xs[:6])
    phrases = [f'"{p}"' for p in terms["phrases"]]
    raw = [alt(phrases), alt(phrases[6:]), alt(terms["names"]),
           " ".join([anchor[0]] + [c[0] for c in others[:2]]) if len(others) > 1 else "",
           f"{anchor[0]} {others[0][0]}" if others else alt(anchor),
           f"{alt(anchor)} sort:stars",
           f"{anchor[0]} {others[0][0]} sort:stars" if others else ""]
    raw += [f"{anchor[0]} {s}" for o in others for s in o[:2]]
    m = re.search(r"\balternative (?:to|for) ([\w.-]+)", need, re.I)
    if m:  # "alternative to X": the repos that say so, and the topic GitHub uses for them
        x = m.group(1).lower()
        raw = [f"topic:{x}-alternative", f'"{x} alternative"'] + raw
    q = qualifiers(a)
    return [f"{r} {q}" for r in dict.fromkeys(r for r in raw if r)][:14]


GH = shutil.which("gh")


def gh(args, body=None):
    p = subprocess.run([GH] + args, input=body, capture_output=True, text=True, encoding="utf-8", timeout=90)
    try:
        return json.loads(p.stdout or "{}")
    except ValueError:
        raise RuntimeError((p.stderr or p.stdout).strip()[:300])


def discover_topics(terms, need_tokens):
    """GitHub topics named like the need (pdf-to-text, habit-tracker), from /search/topics for the first keywords."""
    found = {}
    def one(k):
        return gh(["api", "-X", "GET", "search/topics", "-f", f"q={k}", "-f", "per_page=30"]).get("items", [])
    with ThreadPoolExecutor(4) as ex:
        for items in ex.map(one, terms["keywords"][:4]):
            for t in items:
                words = {singular(w) for w in t["name"].split("-")}
                # Multi-word topics made only of the need's words (rss-reader, block-ads) say what the need says.
                if len(words) > 1 and words <= need_tokens and t["name"] not in NOISE_TOPICS and t["name"] not in BROAD_TOPICS and not words <= ROLE:
                    found[t["name"]] = max(found.get(t["name"], 0), len(words) + (1 if t.get("curated") or t.get("featured") else 0))
    return [n for n, _ in sorted(found.items(), key=lambda kv: -kv[1])[:5]]


SEARCH = """search(query: %s, type: REPOSITORY, first: 100%s) { repositoryCount nodes { ... on Repository {
  nameWithOwner description stargazerCount forkCount pushedAt isArchived isFork primaryLanguage { name }
  licenseInfo { spdxId } repositoryTopics(first: 8) { nodes { topic { name } } } } } }"""


def fetch_pages(jobs):
    """jobs: (query, page), one GraphQL search each, ten at a time, one retry. GitHub's search cursors are an encoded
    offset, so every page can be asked for at once. Returns {(query, page): (count, nodes)}."""
    def run(job):
        q, page = job
        after = ', after: "%s"' % base64.b64encode(f"cursor:{page * 100}".encode()).decode() if page else ""
        for _ in range(2):
            try:
                s = (gh(["api", "graphql", "--input", "-"], json.dumps({"query": "{ " + SEARCH % (json.dumps(q), after) + " }"})).get("data") or {}).get("search")
                if s:
                    return job, (s.get("repositoryCount", 0), s.get("nodes") or [])
            except Exception:
                pass
        return job, (0, [])
    with ThreadPoolExecutor(10) as ex:
        return dict(ex.map(run, jobs))


def pool_of(results, queries, size):
    """Deduplicated repos ordered by page, then query (GitHub's own order), without archived repos and forks."""
    pool = {}
    for page in range(10):
        for q in queries:
            for n in (results.get((q, page)) or (0, []))[1]:
                if n and n.get("nameWithOwner") and not n["isArchived"] and not n["isFork"]:
                    pool.setdefault(n["nameWithOwner"].lower(), n)
    return list(pool.values())[:size]


def stem(w):
    """For word matching only: scraper, scraping and scrape meet at scrap; blocker and block at block."""
    w = singular(w)
    for suf in ("ings", "ing", "ers", "er", "ed", "es", "e"):
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[: -len(suf)]
    return w


def words_of(t):
    return [stem(w) for w in re.findall(r"[a-z0-9+#.]{2,}", (t or "").lower())]


# Ranking settings, tuned offline on AppForge's 50 test needs (scripts/eval-repo-finder.py there).
TUNE = {"junk": True, "prf_docs": 50, "prf_terms": 12, "prf_weight": 0.4, "starred": 3}
JUNK_NAME = re.compile(r"^awesome|\d+[-_]days|(^|[-_.])(tutorials?|courses?|homework|assignments?|dotfiles|examples?|"
                       r"demos?|starter|boilerplate|interview|cheatsheet|roadmap|notes|learn|learning|study)([-_.]|$)")
JUNK_TEXT = re.compile(r"\b(curated list|awesome list|a list of|collection of (resources|links|tools)|tutorials? (for|on)|"
                       r"course (on|for)|homework|my (notes|dotfiles))\b")


def topic_names(n):
    return [t["topic"]["name"] for t in (n.get("repositoryTopics") or {}).get("nodes", [])]


def junk(n, need):
    """Lists, tutorials, courses, dotfiles, unless the need asks for them."""
    name, text = n["nameWithOwner"].split("/")[1].lower(), (n.get("description") or "").lower()
    if not text and n["stargazerCount"] < 20:
        return True
    hit = JUNK_NAME.search(name) or JUNK_TEXT.search(text) or {"awesome", "awesome-list", "tutorial", "course"} & set(topic_names(n))
    return bool(hit) and not re.search(r"awesome|list|tutorial|course|example|learn|starter|boilerplate|template|"
                                       r"dotfile|track|resource|collection", need.lower())


def rank(pool, terms, small=False, need=""):
    """BM25 over name (twice), description and topics, plus words the best matches share, blended with GitHub's
    order and popularity."""
    if TUNE["junk"]:
        pool = [n for n in pool if not junk(n, need)]
    q = {stem(w): 1.0 for c in terms["concepts"] for t in c for w in re.split(r"[\s-]+", t)}
    docs = []
    for n in pool:
        name = words_of(n["nameWithOwner"].split("/")[1].replace("-", " ").replace("_", " "))
        docs.append(name + name + words_of(n.get("description")) + [stem(w) for t in topic_names(n) for w in t.split("-")])
    avg = sum(map(len, docs)) / max(1, len(docs))
    bags, df = [set(d) for d in docs], {}
    for b in bags:
        for t in b:
            df[t] = df.get(t, 0) + 1
    idf = lambda t: math.log(1 + (len(docs) - df.get(t, 0) + 0.5) / (df.get(t, 0) + 0.5))
    def bm25(d, query):
        s = 0.0
        for t, w in query.items():
            tf = d.count(t)
            if tf:
                s += w * idf(t) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * len(d) / avg))
        return s
    clamp = lambda x: max(0.0, min(1.0, x))
    prom = lambda n: 0.8 if small else clamp(math.log10(n["stargazerCount"] + 1) / 5)
    cred = lambda n: 1 if small else clamp(math.log10(n["stargazerCount"] + 2 * n["forkCount"] + 1) / 2.2)
    def blend(query):
        bm = [bm25(d, query) for d in docs]
        top = max(bm, default=0) or 1
        return sorted(((0.35 * b / top + 0.3 * (1 - i / len(pool)) + 0.2 * prom(n) + 0.15 * cred(n), b, i)
                       for i, (b, n) in enumerate(zip(bm, pool))), key=lambda x: -x[0])
    scored = blend(q)
    if TUNE["prf_terms"]:
        # Words the best matches share that the need does not use (vault and keepass for "password manager").
        best = [x for x in scored[: TUNE["prf_docs"]] if x[1] > 0]
        weight = {}
        for s, _, i in best:
            for t in bags[i]:
                if t not in q and len(t) > 2 and t not in STOPWORDS and singular(t) not in GENERIC and not t.isdigit():
                    weight[t] = weight.get(t, 0) + s
        common = [t for t in weight if sum(1 for _, _, i in best if t in bags[i]) >= 3]
        common = sorted(common, key=lambda t: -weight[t] * idf(t))[: TUNE["prf_terms"]]
        if common:
            hi = max(weight[t] * idf(t) for t in common)
            scored = blend({**q, **{t: TUNE["prf_weight"] * weight[t] * idf(t) / hi for t in common}})
    return [(s, b, pool[i]) for s, b, i in scored]


def stars(n):
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def parser():
    ap = argparse.ArgumentParser(description="Find open-source projects on GitHub by what they do.")
    ap.add_argument("need", help="what the project should do, in plain words")
    ap.add_argument("--language")
    ap.add_argument("--license", action="append", help="SPDX id, repeatable (MIT, Apache-2.0)")
    ap.add_argument("--min-stars", type=int)
    ap.add_argument("--pushed-within", type=int, help="days")
    ap.add_argument("--small", action="store_true", help="little-known projects: no popularity bonus")
    ap.add_argument("--limit", type=int, default=100, help="full lines")
    ap.add_argument("--names", type=int, default=200, help="further repos as names and stars only")
    ap.add_argument("--pool", type=int, default=1000)
    return ap


def collect(a, terms):
    """All the GitHub searches for a need: returns (pool, searches run, topics searched)."""
    need_tokens = {singular(w) for w in re.findall(r"[\w+#]+", a.need.lower())} | {s for c in terms["concepts"] for s in c}
    try:
        topics = discover_topics(terms, need_tokens)
    except Exception:
        topics = []
    q = qualifiers(a)
    queries = list(dict.fromkeys(build_queries(a.need, terms, a) + [f"topic:{t} {q}" for t in topics]))
    if not queries:
        sys.exit("No searchable words in the need; describe what the project should do.")
    first = fetch_pages([(x, 0) for x in queries])
    # Round 2: topics shared by the 30 best matches so far (scrapy for "scrape", logseq for "Notion").
    best = [n for _, _, n in rank(pool_of(first, queries, a.pool), terms, a.small)[:30]]
    seen = {t.replace("-", "") for t in topics + terms["keywords"]}
    counts = {}
    for n in best:
        for t in {x["topic"]["name"] for x in (n.get("repositoryTopics") or {}).get("nodes", [])}:
            if t.replace("-", "") not in seen and t not in NOISE_TOPICS | BROAD_TOPICS and t not in ROLE and t not in LANGUAGES:
                counts[t] = counts.get(t, 0) + 1
    expansion = [t for t, c in sorted(counts.items(), key=lambda kv: -kv[1]) if c >= 3][:5]
    more, expected = [], sum(len(v[1]) for v in first.values())
    for page in range(1, 10):
        for x in queries:
            if expected < a.pool * 1.5 and first.get((x, 0), (0, []))[0] > page * 100:
                more.append((x, page))
                expected += 100
    round2 = [f"topic:{t} {q}" for t in expansion]
    results = dict(first)
    results.update(fetch_pages(more + [(x, 0) for x in round2]))
    return pool_of(results, queries + round2, a.pool + 500), len(queries) + len(round2), topics + expansion


def select(pool, terms, a):
    """The --limit + --names repos to print: best match first, then the most-starred that match a word (famous
    projects often describe themselves vaguely)."""
    scored = rank(pool, terms, a.small, a.need)
    k = min(a.limit + a.names, len(scored))
    share = k // TUNE["starred"] if TUNE["starred"] else 0
    head = scored[: k - share]
    starred = sorted((s for s in scored[k - share:] if s[1] > 0), key=lambda s: -s[2]["stargazerCount"])[:share]
    return [n for _, _, n in head + starred]


def render(shown, limit):
    """Full lines for the first `limit`, then names and stars only, ten to a line (a quarter of the tokens)."""
    out = ["rank. owner/name | stars | language | licence | last push | description | topics"]
    for i, n in enumerate(shown[:limit], 1):
        topics_n = ", ".join(topic_names(n)[:2])
        desc = re.sub(r"\s+", " ", n.get("description") or "")[:70]
        out.append(f"{i}. {n['nameWithOwner']} | {stars(n['stargazerCount'])} | {(n.get('primaryLanguage') or {}).get('name', '-')}"
                   f" | {(n.get('licenseInfo') or {}).get('spdxId') or '-'} | {(n.get('pushedAt') or '-')[:7]} | {desc} | {topics_n}")
    rest = shown[limit:]
    if rest:
        out.append(f"More matches, name and stars only ({limit + 1}-{len(shown)}):")
        out += ["; ".join(f"{n['nameWithOwner']} {stars(n['stargazerCount'])}" for n in rest[j:j + 10])
                for j in range(0, len(rest), 10)]
    return "\n".join(out)


def main():
    a = parser().parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # descriptions carry emoji; Windows consoles default to cp125x
    if not GH:
        sys.exit("The GitHub CLI is needed: install it from https://cli.github.com and run `gh auth login`.")
    if not a.language:
        a.language = next((LANGUAGES[t] for t in re.findall(r"[\w+#]+", a.need.lower()) if t in LANGUAGES), None)
    terms = extract_terms(a.need)
    pool, searches, searched = collect(a, terms)
    shown = select(pool, terms, a)
    print(f"Need: {a.need}")
    print(f"{len(pool)} repositories from {searches} GitHub searches; topics searched: {', '.join(searched) or 'none'}. "
          f"Lists, tutorials and courses left out. Best word match and popularity first, then the most-starred that "
          f"match a word.")
    print(render(shown, a.limit))


if __name__ == "__main__":
    main()
