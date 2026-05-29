---
name: livehtml
description: Use livehtml to publish an agent-generated HTML page that has persistent, multi-user state — checkboxes, form fields, notes, ratings, and toggles sync in real-time across everyone who opens the URL, and survive page reloads. Trigger this skill whenever the user wants a shareable interactive HTML report, a team checklist or form, an annotatable document, a poll/feedback page, a milestone tracker, an agent report with markable items, or anything that fits "make a page the team can click/type into and the state sticks". Also trigger for phrasings like "host this HTML", "live HTML", "collaborative HTML", "shareable form", "让大家在网页上勾/填", "做个团队反馈页", "agent 报告加上协作能力". Even if the user just asks to "make an HTML report", if multi-user interaction or persistent state would clearly improve it, prefer livehtml over plain static HTML.
---

# livehtml

A deployed service that **hosts HTML files + provides real-time multi-user state**. One URL gets the team a shared interactive page; any element with `data-live="key"` automatically syncs across browsers.

## Setup — load the base URL

Every command below uses `$LIVEHTML_BASE_URL`. Load it once per shell:

```bash
export LIVEHTML_BASE_URL=$(cat ~/.local/state/livehtml/base-url)
```

If that file is missing (installed from source, or never configured), create it with your deployment URL, then re-run the line above:

```bash
mkdir -p ~/.local/state/livehtml
echo 'http://your-livehtml-host:port' > ~/.local/state/livehtml/base-url
```

> If `$LIVEHTML_BASE_URL` is empty, **stop** and do the setup — every `curl` and `<script src>` below depends on it.

## When this skill saves the day

- "Make a team checklist where everyone can tick items off"
- "Host this report so the group can mark which findings to follow up on"
- "Build a quick feedback form for tomorrow's lunch menu"
- "A page where each of us picks our preferred time slot"
- "Make this analysis interactive — let people annotate"

## The two-step workflow

1. **Write HTML** that includes the script tag and `data-live` attributes (template below)
2. **PUT it** to `/pages/<key>`. The URL `$LIVEHTML_BASE_URL/pages/<key>` is now live and shareable.

That's it. No build step, no config, no MinIO access needed.

## Minimum HTML boilerplate

The `<script>` tag is the entire integration — no `<meta>` tags, no init code, no manual room id. Generate the file so `$LIVEHTML_BASE_URL` expands into the script src (a heredoc does this):

```bash
cat > page.html <<EOF
<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>your title</title></head>
<body>

  <!-- mark anything you want synced with data-live="<unique-key>" -->
  <input type="checkbox" data-live="task-1"> 任务一
  <textarea data-live="notes"></textarea>

  <script src="$LIVEHTML_BASE_URL/sync.js"></script>
</body>
</html>
EOF
```

The served HTML must contain the **literal** resolved URL in `src` — browsers don't expand shell variables.

**Why no meta tag for room id**: when the page is served at `/pages/foo/bar`, sync.js reads `location.pathname` and derives the room id automatically. URL = MinIO key = state room — one identifier for everything.

## Upload

```bash
curl -X PUT --data-binary @page.html \
  $LIVEHTML_BASE_URL/pages/<key>
```

- `<key>` can include `/` for hierarchy (e.g. `team-x/2026-05-22/standup`)
- Use stable, descriptive keys — they show up in the URL the team will see
- Re-uploading with the same key overwrites the HTML but **keeps the state** (intentional — content can evolve, annotations persist)
- Share the URL: `$LIVEHTML_BASE_URL/pages/<key>`

## What kinds of elements work

Anything with a `data-live="<key>"` attribute. sync.js detects the element type automatically:

| Element | What gets synced |
|---|---|
| `<input type="checkbox">` | `checked` (boolean) |
| `<input type="radio">` | `checked` (boolean) |
| `<input type="text\|email\|search\|url\|tel\|password">` | `value` (string) |
| `<input type="number">` | `value` (number or null) |
| `<input type="range">` | `value` (number) |
| `<textarea>` | `value` (string) |
| `<select>` | `value` (string; array if `multiple`) |
| `<details>` | `open` (boolean) |
| anything `contenteditable` | `innerHTML` |
| anything else | `textContent` |

Each `data-live="..."` key is independent. Two elements with the same key stay in sync with each other (useful for "summary at top + detail at bottom" patterns).

## Read back state (agent-side)

Once a page is live, its state is plain JSON. Read it back to see what users
have done, aggregate across pages, or feed results into the next agent step.
The canonical endpoint is `/pages/<key>/state` — same identifier as the page
URL. The legacy `/state/pages/<key>` is byte-for-byte equivalent and still
works.

All three cookbooks use `-A "livehtml-agent-readback/1"` so the server access
log can distinguish agent read-backs from browser traffic. Keep it.

### Cookbook 1 — read one page's state

```bash
curl -A "livehtml-agent-readback/1" \
  $LIVEHTML_BASE_URL/pages/<key>/state
# {"task-1": true, "notes": "...", "status": "doing"}
```

The canonical "did the user actually fill it in / click it?" check. Common
pattern: agent PUTs a page → user fills it → agent reads back to continue.

### Cookbook 2 — aggregate across pages

```bash
# List keys, then fetch each page's state
for key in $(curl -sA "livehtml-agent-readback/1" \
                  $LIVEHTML_BASE_URL/pages/ | jq -r '.[].key'); do
  state=$(curl -sA "livehtml-agent-readback/1" \
               "$LIVEHTML_BASE_URL/pages/$key/state")
  echo "$key: $state"
done
```

Use for: "summarise every standup form filed today", "find which review pages
are still empty", "collect all triage decisions across tickets".

### Cookbook 3 — debug "the state isn't what I expected"

Run these in order; the first miss tells you where things broke:

```bash
# Is the page even hosted?
curl -sI -A "livehtml-agent-readback/1" \
  $LIVEHTML_BASE_URL/pages/<key> | head -1
# 200 = HTML is there. 404 = key typo or PUT never landed.

# What's in state right now?
curl -sA "livehtml-agent-readback/1" \
  $LIVEHTML_BASE_URL/pages/<key>/state
# {} = nobody has interacted yet, or DELETE cleared it.

# Are the data-live keys what you expect?
# Compare keys above to the data-live="..." attributes in your HTML.
# Mismatch = typo or the element isn't a leaf interactive node.

# Is anyone currently connected?
curl -sA "livehtml-agent-readback/1" \
  $LIVEHTML_BASE_URL/rooms | jq '.[] | select(.room=="pages/<key>")'
# peers > 0 = someone is viewing right now.
```

If state reads `{}` but the user swears they filled the form, ask them to
open DevTools → Network → WS and confirm `set` messages fire when they type
— that proves the browser-side `data-live` wiring is healthy.

### Cookbook 4 — wait for the user to act (long-poll)

When you've just asked the user to tick a box or submit a form and expect them
to act **soon**, you can block **in this same turn** until they do — instead of
burning a `sleep N; curl` recheck loop. The server holds the request open until
state changes or `wait` seconds elapse.

Long-poll uses an opaque cursor, `since=<etag>`. Bootstrap it with one quick
call (an empty `since` returns the current cursor immediately — it does **not**
wait), then block on a second call:

```bash
# 1. grab the current cursor (returns right away)
etag=$(curl -sA "livehtml-agent-readback/1" \
  "$LIVEHTML_BASE_URL/pages/<key>/state?wait=1&since=" | jq -r .etag)

# 2. block up to 60s for the next write past that cursor
curl -sA "livehtml-agent-readback/1" \
  "$LIVEHTML_BASE_URL/pages/<key>/state?wait=60&since=$etag"
```

The blocking call returns one of three shapes (look at `.status`):

| `.status` | meaning | what to do next |
|---|---|---|
| `changed` | someone wrote since your cursor | use `.state`; your new cursor is `.etag` |
| `not_modified` | `wait` elapsed, nothing changed | nobody acted in time — tell the user you'll check back, or poll again |
| `reset` | server restarted (or first call) | adopt `.state` + `.etag`, then poll again |

`wait` is capped at 60s. **Don't park after every PUT** — only long-poll when an
interaction is genuinely imminent. Otherwise just end your turn and read the
state back later with Cookbook 1.

If you're a long-running watcher or orchestrator (not a single agent turn),
loop — carry `.etag` forward each iteration, and jitter reconnects so parallel
watchers don't all wake in lockstep:

```bash
since=""   # empty → first reply is `reset`, which carries the live cursor
while :; do
  resp=$(curl -sA "livehtml-agent-readback/1" \
    "$LIVEHTML_BASE_URL/pages/<key>/state?wait=60&since=$since")
  since=$(jq -r .etag <<<"$resp")
  [ "$(jq -r .status <<<"$resp")" = changed ] && jq -c .state <<<"$resp"
  sleep $((RANDOM % 3))   # jitter
done
```

> **Field-level metadata (`?meta=1`)** — a plain GET supports `?meta=1`, which
> returns `{version:2, fields:{<key>:{v, ts, by}}}` — when each key was last
> written and by which connection. This is for **debugging / storage
> inspection only**; normal agent workflows should read the flat state
> (Cookbook 1). `by` is an opaque connection label, **not an authenticated
> identity** — don't infer who-did-what or provenance from it.

## 受保护部署（可选）

若部署启用了登录/令牌保护：

- **Agent 调用带令牌**：从 `~/.local/state/livehtml/api-token`（若存在）读取令牌，并在所有 `PUT /pages/<key>`、`GET/PUT/DELETE /pages/<key>/state`、`/state/<room>`、`/rooms` 请求上加头：
  `Authorization: Bearer <token>`
  未配置令牌的部署无需此头（向后兼容）。
- **公开某个页面**（免登浏览）：上传时加头 `X-Public: 1`：
  `curl -fsS -X PUT -H "X-Public: 1" --data-binary @page.html "$BASE/pages/<key>"`
  默认（不带该头）页面为受保护，需钉钉登录后才能查看。
- **人类查看者**：受保护页面在浏览器打开时会跳转钉钉扫码登录，仅本企业成员可访问；`by`/在线名单显示其真实姓名。生成的 HTML 无需任何改动。

## Managing pages

```bash
# List everything published
curl $LIVEHTML_BASE_URL/pages/

# Delete a page (also clears its state)
curl -X DELETE $LIVEHTML_BASE_URL/pages/<key>
```

## Debugging when something seems off

1. **Open the page in a browser**. Look at the top-right floating chip:
   - **Green dot**: WebSocket connected, you're in
   - **Grey dot**: not connected — check that `$LIVEHTML_BASE_URL` is reachable from that browser
   - Number = how many people currently viewing
2. **Check the state directly**: `curl $LIVEHTML_BASE_URL/state/pages/<key>` — if your DOM changes don't show up here within a second of changing them, the `data-live` attribute likely isn't set or the key has a typo
3. **Open browser DevTools → Network → WS**: should see one persistent connection to `/ws`, with `set`/`pres` messages flying when things change
4. **List pages**: `curl $LIVEHTML_BASE_URL/pages/` to confirm your PUT actually landed

## Anti-patterns — don't do these

- **Don't expect livehtml to inject anything**. What you PUT is exactly what gets served. The boilerplate must be in the HTML you generate; no `<script>` tag will appear by magic.
- **Don't write directly to the MinIO backend**. The whole point of `PUT /pages/` is that one identifier covers HTML + state + URL. Bypassing it splits naming and causes orphan state.
- **Don't use livehtml for true concurrent text editing**. The sync is last-write-wins, not CRDT. Two users typing simultaneously in the same `<textarea>` will overwrite each other character-by-character. Fine for "one person edits at a time" or "occasional updates"; not fine for Google-Docs-style collaboration. For that, use Yjs.
- **Don't pick a random `data-live` key per render**. The key is the persistence identity. If you regenerate HTML with new keys, the old state becomes unreachable.
- **Don't try to nest `data-live` containers**. Each attribute should be on a leaf interactive element. A `<div data-live="x">` containing other `data-live` elements gives unpredictable results.
- **Don't put secrets in `data-live` values**. State is readable by anyone with the URL — there's no auth.

## Optional: customizing user presence

By default each user gets a random `User-XXXX` name shown in the chip. To set explicitly:

```html
<meta name="livehtml-user" content='{"name":"范晓"}'>
```

Or let the user click their name in the chip to change it (saved in their localStorage).

## Resources beyond this skill

- Source code + full README: https://github.com/fxghqc/livehtml
- Live landing page with endpoint docs: `$LIVEHTML_BASE_URL/`

If your scenario doesn't fit the patterns here, read the README — it covers WebSocket protocol details, presence customization, multi-element same-key tricks, and the full HTTP API.
