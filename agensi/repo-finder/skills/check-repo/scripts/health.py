#!/usr/bin/env python3
"""Health and risk evidence for 1-5 GitHub repositories, in one GraphQL call through the GitHub CLI (`gh auth login`).
Python 3.8+ standard library only.

  python health.py owner/name [owner/name ...] [--readme 1500]

Prints, per repository: what it is, activity (commits in the last 90 days, last push, latest release), community
(contributors, open and closed issues and pull requests), licence, and flags for the usual risks: archived, a fork,
no licence or a copyleft one, no commit for a year, a single maintainer, an issue backlog, no release.
"""
import argparse, datetime, json, re, shutil, subprocess, sys

FIELDS = """nameWithOwner description url homepageUrl stargazerCount forkCount isArchived isFork pushedAt createdAt
primaryLanguage { name } licenseInfo { spdxId name } repositoryTopics(first: 8) { nodes { topic { name } } }
releases(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { tagName publishedAt } }
openIssues: issues(states: OPEN) { totalCount } closedIssues: issues(states: CLOSED) { totalCount }
openPRs: pullRequests(states: OPEN) { totalCount } mergedPRs: pullRequests(states: MERGED) { totalCount }
mentionableUsers { totalCount }
defaultBranchRef { target { ... on Commit { recent: history(since: "%s") { totalCount } } } }
readmeUpper: object(expression: "HEAD:README.md") { ... on Blob { text } }
readmeLower: object(expression: "HEAD:readme.md") { ... on Blob { text } }"""
COPYLEFT = {"GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0", "MPL-2.0", "EUPL-1.2", "SSPL-1.0"}


def months(iso):
    if not iso:
        return None
    then = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.datetime.now(datetime.timezone.utc) - then).days / 30.4


def main():
    ap = argparse.ArgumentParser(description="Health and risk evidence for GitHub repositories.")
    ap.add_argument("repos", nargs="+", help="owner/name or GitHub URLs, up to 5")
    ap.add_argument("--readme", type=int, default=1500, help="characters of README to show (0 = none)")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    gh = shutil.which("gh")
    if not gh:
        sys.exit("The GitHub CLI is needed: install it from https://cli.github.com and run `gh auth login`.")
    names = [re.sub(r"^(https?://github\.com/)|(\.git)?/?$", "", r.strip()) for r in a.repos][:5]
    since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%SZ")
    parts = []
    for i, n in enumerate(names):
        if "/" not in n:
            sys.exit(f"Not owner/name: {n}")
        owner, name = n.split("/", 1)
        parts.append(f"r{i}: repository(owner: {json.dumps(owner)}, name: {json.dumps(name)}) {{ {FIELDS % since} }}")
    p = subprocess.run([gh, "api", "graphql", "--input", "-"], input=json.dumps({"query": "{ " + " ".join(parts) + " }"}),
                       capture_output=True, text=True, encoding="utf-8", timeout=90)
    try:
        data = json.loads(p.stdout or "{}").get("data") or {}
    except ValueError:
        sys.exit((p.stderr or p.stdout).strip()[:300])
    for i, n in enumerate(names):
        r = data.get(f"r{i}")
        if not r:
            print(f"## {n}\nNot found (renamed, private or misspelled).\n")
            continue
        lic = (r.get("licenseInfo") or {}).get("spdxId") or "none"
        rel = (r.get("releases") or {}).get("nodes") or []
        recent = ((r.get("defaultBranchRef") or {}).get("target") or {}).get("recent", {}).get("totalCount", 0)
        open_i, closed_i = r["openIssues"]["totalCount"], r["closedIssues"]["totalCount"]
        contributors = r["mentionableUsers"]["totalCount"]
        idle = months(r.get("pushedAt"))
        flags = []
        if r["isArchived"]:
            flags.append("ARCHIVED: read-only, no fixes coming")
        if r["isFork"]:
            flags.append("a fork: check whether the original is the one to use")
        if lic in ("none", "NOASSERTION"):
            flags.append("no standard licence: reuse is legally unclear, read the LICENSE file")
        elif lic in COPYLEFT:
            flags.append(f"{lic} is copyleft: linking or shipping it can oblige you to share your code")
        if idle is not None and idle > 12:
            flags.append(f"no push for {idle:.0f} months")
        elif recent == 0:
            flags.append("no commits on the default branch in 90 days")
        if contributors <= 2:
            flags.append("one or two people can push: bus factor")
        if open_i > 50 and open_i > closed_i:
            flags.append(f"more open issues ({open_i}) than closed ({closed_i}): backlog")
        if not r["releases"]["totalCount"]:
            flags.append("no releases: you pin a commit, not a version")
        readme = (r.get("readmeUpper") or r.get("readmeLower") or {}).get("text") or ""
        print(f"## {r['nameWithOwner']}  ({r['url']})")
        print(f"{r.get('description') or '(no description)'}")
        print(f"- {r['stargazerCount']:,} stars, {r['forkCount']:,} forks; {(r.get('primaryLanguage') or {}).get('name', '-')}; "
              f"licence {lic}; created {r['createdAt'][:10]}" + (f"; site {r['homepageUrl']}" if r.get("homepageUrl") else ""))
        print(f"- activity: {recent} commits in 90 days, last push {(r.get('pushedAt') or '-')[:10]}; "
              + (f"{r['releases']['totalCount']} releases, latest {rel[0]['tagName']} on {rel[0]['publishedAt'][:10]}" if rel else "no releases"))
        print(f"- community: {contributors} people with push or mention access; issues {open_i} open / {closed_i} closed; "
              f"pull requests {r['openPRs']['totalCount']} open / {r['mergedPRs']['totalCount']} merged")
        topics = ", ".join(t["topic"]["name"] for t in r["repositoryTopics"]["nodes"])
        if topics:
            print(f"- topics: {topics}")
        print("- flags: " + ("; ".join(flags) if flags else "none"))
        if a.readme and readme:
            # Without HTML, images, badge links and entities, which a README's start is often made of.
            text = re.sub(r"<[^>]+>|!\[[^\]]*\]\([^)]*\)|&[a-z]+;", "", readme)
            text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
            text = "\n".join(l.rstrip() for l in text.splitlines() if l.strip(" #-*|")).strip()[: a.readme]
            print(f"- README start:\n{text}")
        print()


if __name__ == "__main__":
    main()
