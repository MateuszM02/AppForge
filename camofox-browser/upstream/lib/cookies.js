// Compatibility re-export. Cookie parsing ships with @askjo/camofox-browser-mcp so its
// standalone cookie-import tool has the same path-containment behavior as core.
export {
  parseNetscapeCookieFile,
  readCookieFile,
  importBootstrapCookies,
} from '../mcp/lib/cookies.mjs';
