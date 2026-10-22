# Upstream: camofox-browser

- Repository: https://github.com/jo-inc/camofox-browser (MIT, Copyright (c) 2025 Jo, Inc)
- Version 1.18.1, commit `39c82094013480b373df6600d44c7f036f58356e`
- Copied: `server.js`, `postinstall.js`, `package.json`, `camofox.config.json`, `openapi.json`, `LICENSE`,
  `README.md`, `lib/`, `bin/`, `plugins/` (youtube, persistence, vnc)
- Not copied: tests, docs, images, Docker/Fly/Railway files, its own MCP package (`mcp/`), the OpenClaw plugin,
  the crash-reporter Cloudflare worker
- Local changes to upstream files: **none**. Its npm dependencies are declared in AppForge's root
  `package.json` (`better-sqlite3` ^13.0.3 instead of the pinned 13.0.1, which has no prebuilt binary for Node 24
  on Windows). Configuration is passed as environment variables by [src/manager.ts](src/manager.ts).
