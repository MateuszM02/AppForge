# plugin

AppForge's workflow skills, in the cross-agent `SKILL.md` format, packaged as a Claude-format plugin:

| Skill | Use |
|---|---|
| [create-app](skills/create-app/SKILL.md) | build something new: reuse existing projects and skills first |
| [improve-app](skills/improve-app/SKILL.md) | change the open project: libraries, skills and docs before code |
| [find-app](skills/find-app/SKILL.md) | find and compare existing apps, libraries and skills |
| [remember](skills/remember/SKILL.md) | save and look up long-term memory |

They need the AppForge MCP server (install it first, see the [root README](../README.md)); the plugin itself does
not start a server, so AppForge is never registered twice.

- **Claude Code**: `/plugin marketplace add MateuszM02/AppForge`, then `/plugin install appforge@appforge`.
- **VS Code**: Command Palette → *Chat: Install Plugin From Source* → `https://github.com/MateuszM02/AppForge`,
  or copy the skill folders into `~/.copilot/skills/` (all projects) or `.github/skills/` (one project).
- **Other agents**: copy the folders into the agent's skills folder (`~/.agents/skills/`, `~/.cursor/skills/`, ...).

The same workflows are also available without the plugin as MCP prompts (`create-app`, `improve-app`, `find-app`).
