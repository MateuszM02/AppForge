# camofox-browser (in AppForge)

A stealth web browser for agents: [camofox-browser](https://github.com/jo-inc/camofox-browser) (MIT), vendored in
[upstream/](upstream/), wraps [Camoufox](https://camoufox.com), a Firefox build that spoofs its fingerprint at the
C++ level, in a REST API made for agents. Pages come back as compact accessibility snapshots (about 90% smaller
than HTML) with stable element refs (`e1`, `e2`, ...) to click or type into.

AppForge ([src/manager.ts](src/manager.ts)) runs it as a child process:

- started on the first browser call, on `127.0.0.1` and a free port, with a random access key per run;
- stopped after `browser.idleMinutes` (10) without a call, and when the MCP server exits (the whole process tree);
- crash telemetry, which upstream sends to GitHub Issues by default, is switched off; Prometheus metrics too;
- profiles, cookies, uploads and traces live in AppForge's `browser/` data folder.

The Camoufox binary (~300 MB) is downloaded by the installer (`appforge setup browser`) into camoufox's standard
cache, using upstream's own `postinstall.js`.

## Tools

| Tool | What it does |
|---|---|
| `browser_open` | open a URL in a new tab; returns the tab id and the page snapshot |
| `browser_snapshot` | the current snapshot; long pages come in parts of `browser.maxSnapshotChars` (15,000) characters, read on with `offset`; `screenshot: true` adds an image |
| `browser_act` | `click`, `type` (optional Enter), `press` a key, `select` an option, `scroll`; returns the new snapshot |
| `browser_navigate` | go to a URL, run a search macro (`@google_search`, `@youtube_search`, `@reddit_search`, `@wikipedia_search`, ... 13 in all), or back / forward / refresh |
| `browser_extract` | structured data with a JSON Schema whose properties point at refs (`"x-ref": "e14"`) |
| `browser_tabs` | list tabs, close one, or close all and stop the browser |
| `browser_import_cookies` | load a Netscape `cookies.txt` you exported, to browse logged in (only with your consent) |
| `browser_evaluate` | run JavaScript in the page; **off** unless `tools.browserEvaluate` is true |

## Code

- [src/manager.ts](src/manager.ts): process lifecycle, health check, idle stop, Camoufox download.
- [src/tools.ts](src/tools.ts): MCP tools on the upstream REST API, cookies.txt parser.
