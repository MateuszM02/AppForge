"""PreToolUse hook on `git commit`: enforces the version rule in AGENTS.md.

When the commit changes the app (anything except docs, tests, eval scripts and agent rule files), package.json must
have a newer version than the pushed branch (@{u}), and package-lock.json and plugin/.claude-plugin/plugin.json must
match it. One bump per push is enough. Denies with a one-line reason; costs nothing when the rule holds.
"""
import json
import re
import subprocess
import sys

NOT_APP = re.compile(r"\.md$|^tests/|^scripts/eval-|^\.claude/|^LICENSE$|^\.git(ignore|attributes)$")

try:
    event = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    cmd = event.get("tool_input", {}).get("command", "")
    if re.search(r"\bgit\b.*\bcommit\b", cmd):
        def git(*a):
            return subprocess.run(["git", "-C", event.get("cwd", "."), *a], capture_output=True, text=True,
                                  encoding="utf-8").stdout

        def version(text):
            return json.loads(text or "{}").get("version")

        # A command that stages files first (git add, commit -a) commits the working tree, else only the index.
        stages = re.search(r"\bgit\b.*\badd\b|\bcommit\b.*\s-(a|-all)\b|\bcommit\b.*\s-\w*a\w*\b", cmd)
        files = ([l[3:].split(" -> ")[-1] for l in git("status", "--porcelain").splitlines()] if stages
                 else git("diff", "--cached", "--name-only").splitlines())
        if any(not NOT_APP.search(f) for f in files):
            root = git("rev-parse", "--show-toplevel").strip()
            now = {f: version(open(f"{root}/{f}", encoding="utf-8").read())
                   for f in ("package.json", "package-lock.json", "plugin/.claude-plugin/plugin.json")}
            pushed = version(git("show", "@{u}:package.json"))
            why = None
            if pushed and now["package.json"] == pushed:
                why = f"this commit changes the app but package.json is still {pushed}, as pushed. Bump it (AGENTS.md)."
            elif len(set(now.values())) > 1:
                why = "versions differ: " + ", ".join(f"{f} {v}" for f, v in now.items()) + ". Keep them equal."
            if why:
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                         "permissionDecisionReason": f"version gate: {why}"}}))
except Exception as e:
    print(f"version gate error: {e!r}", file=sys.stderr)
    sys.exit(2)
