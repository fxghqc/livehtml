// Server-side injection of the canonical sync.js tag into a published page.
// Kept out of server.ts so the strip regex — the part with real edge cases —
// can be unit-tested without booting a server.

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strips any page-authored `<script src=".../sync.js">` before the canonical
// tag goes in, so `document.currentScript` inside sync.js always resolves to
// the server's tag. With two tags it would bind to whichever ran, and the
// page-authored one carries no `data-*` — the room would silently fall back to
// `location.pathname` and the token would be empty, i.e. a page that quietly
// joins the wrong room instead of failing.
//
// Matches src values ending in a `sync.js` path segment (any prefix must end
// in `/`, so `mysync.js` and `async.js` are left alone) across double-quoted,
// single-quoted and unquoted attribute forms, in any attribute order, with an
// optional `?query`/`#hash`.
export const SYNC_SCRIPT_RE = new RegExp(
  `<script\\b[^>]*\\ssrc\\s*=\\s*(?:` +
    `"(?:[^"]*\\/)?sync\\.js(?:[?#][^"]*)?"` +
    `|'(?:[^']*\\/)?sync\\.js(?:[?#][^']*)?'` +
    `|(?:[^\\s>]*\\/)?sync\\.js(?:[?#][^\\s>]*)?(?=[\\s>])` +
    `)[^>]*>[\\s\\S]*?<\\/script\\s*>`,
  "gi",
);

// Injects the tag as early as possible — after <head> if present, else after
// the <body> open tag, else prepended. Early injection makes window.LiveHtml
// exist before any page script runs: generated pages habitually call LiveHtml
// at top level, and a tail-of-body tag turns that into a fatal ReferenceError.
// sync.js defers its own start() to DOMContentLoaded, holds the first
// onChange/watchRoom callback until then, and buffers pre-connect writes, so
// running this early is safe.
//
// `data-room` is authoritative: the room is the page's identity, and deriving
// it from location.pathname client-side breaks as soon as the page is reached
// by any other path. A page that hard-codes its own data-room loses it here.
export function injectSync(html: string, room: string, token: string): string {
  const stripped = html.replace(SYNC_SCRIPT_RE, "");
  const tag =
    `<script src="/sync.js"` +
    ` data-room="${escapeAttr(room)}"` +
    ` data-token="${escapeAttr(token)}"></script>`;
  const anchor = /<head\b[^>]*>/i.exec(stripped) || /<body\b[^>]*>/i.exec(stripped);
  if (!anchor) return tag + stripped;
  const at = anchor.index + anchor[0].length;
  return stripped.slice(0, at) + tag + stripped.slice(at);
}
