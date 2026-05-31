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

> On a protected deployment (登录/令牌门已开), every read-back call below also needs
> `-H "Authorization: Bearer $(cat ~/.local/state/livehtml/api-token)"` — run `livehtml-login`
> once first (see 受保护部署 below). Unprotected deployments need neither.

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
> written and by whom. This is for **debugging / storage inspection only**;
> normal agent workflows should read the flat state (Cookbook 1). `by` is the
> **verified DingTalk userId** when the login gate is on (trustworthy
> provenance); with the gate off it's an opaque connection label — only treat
> it as identity on a protected deployment.

## 可视化（可选·进阶）：图表 / 表格 / 关系图

数据多的页面，单文件里直接 CDN 引一个库即可，**无需构建**。看相（配色/排版/动效）交给 `frontend-design` skill，这里只管「画什么」。
**优先用「声明式 / 文本驱动」的库** —— agent 写 JSON/文本比手写命令式绘图代码可靠得多。图表元素照常可加 `data-live`（如多人同步「当前视图/筛选」）。下面的库均已核实在活跃维护。

- **通用图表**：[ECharts](https://github.com/apache/echarts)（默认首选，最全）· [Chart.js](https://github.com/chartjs/Chart.js)（轻量 canvas）· [Plotly.js](https://github.com/plotly/plotly.js)（科学/统计/3D）· [ApexCharts](https://github.com/apexcharts/apexcharts.js)（交互漂亮直观）· [charts.css](https://github.com/ChartsCSS/charts.css)（纯 CSS，零 JS，最适合简单条/线）
- **声明式（agent 友好，推荐）**：[Vega-Lite](https://github.com/vega/vega-lite)（JSON 描述图表）· [Mermaid](https://github.com/mermaid-js/mermaid)（文本→流程图/时序/甘特，CDN 一行）· [D2](https://github.com/terrastruct/d2)（更复杂的图；浏览器用 wasm 版）
- **时序**：[uPlot](https://github.com/leeoniya/uPlot)（小而快）· [lightweight-charts](https://github.com/tradingview/lightweight-charts)（金融）
- **表格 / 数据网格**：[Grid.js](https://github.com/grid-js/gridjs)（简单，排序/搜索/分页）· [RevoGrid](https://github.com/revolist/revogrid)（高性能可编辑，Excel 模式）· [Jspreadsheet CE](https://github.com/jspreadsheet/ce) · [AntV S2](https://github.com/antvis/S2)（透视表）
- **关系图 / 流程 / 网络**：[AntV G6](https://github.com/antvis/G6) / [X6](https://github.com/antvis/X6) · [Cytoscape.js](https://github.com/cytoscape/cytoscape.js) · [3d-force-graph](https://github.com/vasturiano/3d-force-graph)（GoJS 也强，但**商业授权**）
- **甘特 / 时间线**：[Frappe Gantt](https://github.com/frappe/gantt) · [vis-timeline](https://github.com/visjs/vis-timeline)
- **大 / 流数据**：[Perspective](https://github.com/perspective-dev/perspective)（web-component，高性能）

最稳的做法：把数据塞进 ECharts `option` 或 Vega-Lite JSON；流程/架构图直接写 Mermaid 文本，让库去渲染。

## 动画（可选·进阶）

单文件 CDN 即可，**能用 CSS 就别上库** —— frontend-design 推荐的「一次编排好的入场动画（staggered `animation-delay`）」纯 CSS 就够。需要 JS 时（均已核实活跃）：

- **[auto-animate](https://github.com/formkit/auto-animate)** —— ⭐ 最贴合 livehtml：零配置，自动给 DOM 增删/重排加过渡。多人实时同步的列表/卡片出现、重排时直接顺滑，一行接入。
- **[Motion](https://github.com/motiondivision/motion)** —— 现代首选，vanilla `animate()` API（已**取代**归档的 Motion One / Popmotion / Framer Motion）。
- **[anime.js](https://github.com/juliangarnier/anime)** —— 通用时间线动画。
- **[GSAP](https://github.com/greensock/GSAP)** —— 复杂/滚动驱动动画（现已全免费），按需再上。
- **[typed.js](https://github.com/mattboldt/typed.js/)** —— 打字机效果（报告开场等）。

不要再用（已归档/合并）：Motion One、Popmotion、Framer Motion（并入 Motion）、lax.js、newcar。

---

> **以下两节仅适用于「部署开启了登录/令牌门」的情况，且都是可选 / 进阶。**
> 普通协作页面就是上面那套——`data-live` + 一行 `<script>` + `PUT`，**生成的 HTML 一个字都不用改**。
> 登录、在线真实姓名、可信 `by`、访问控制全部由 server + sync.js 处理。不在登录门后部署就直接跳过这两节。

## 受保护部署（可选·进阶）

若部署启用了登录/令牌保护：

- **Agent 一次性登录拿令牌**：运行本 skill 自带的 `scripts/livehtml-login.ts`（与本 SKILL.md 同目录），
  例如 `bun ~/.claude/skills/livehtml/scripts/livehtml-login.ts`（路径随 agent 而定；或用 `livehtml-login`）。
  脚本**自动从 `~/.local/state/livehtml/` 读取 base-url**，无需传参。
  浏览器扫码登录钉钉后，个人 API token 自动写入 `~/.local/state/livehtml/api-token`（自动续期，约月级才再扫一次）。
  之后所有 `PUT /pages/<key>`、`GET/PUT/DELETE /pages/<key>/state`、`/state/<room>`、`/rooms` 请求带头：
  `Authorization: Bearer $(cat ~/.local/state/livehtml/api-token)`
  未启用登录/令牌的部署无需此步（向后兼容）。
- **公开某个页面**（免登浏览）：上传时加头 `X-Public: 1`：
  `curl -fsS -X PUT -H "X-Public: 1" --data-binary @page.html "$BASE/pages/<key>"`
  默认（不带该头）页面为受保护，需钉钉登录后才能查看。
- **人类查看者**：受保护页面在浏览器打开时会跳转钉钉扫码登录，仅本企业成员可访问；`by`/在线名单显示其真实姓名。生成的 HTML 无需任何改动。

## 在线身份（可选·进阶）：按连接（clientId）还是按用户（userId）

`LiveHtml.peers` 里每个 peer：
- `p.id` —— **按连接**的关联 id（浏览器 localStorage 的 clientId）。同一个人开两个标签 = 两个 peer。页面默认用它给「自己的」状态做 key。
- `p.user.name` —— 显示名；开了钉钉登录门时是**服务端校验过的真实姓名**，不可伪造。
- `p.user.userId` —— **按用户**的可信 id（钉钉 userId），仅登录后存在。

当前页面自己的身份：`LiveHtml.me = { id, name, userId }`（`userId` 仅登录后有）。

**选哪个做 key：**
- 想「每个浏览器/连接一个席位」（多设备各自标注、互不干扰）→ 用 `p.id` / `LiveHtml.me.id`（默认，向后兼容，匿名也能用）。
- 想「一个人一个身份」（登录后一人一票、跨设备延续、在线列表去重）→ 用 `p.user.userId || p.id` 和 `LiveHtml.me.userId || LiveHtml.me.id`。

例（planning-poker，登录后按 userId 计票）：
```js
function voteKey(){ var m = LiveHtml.me; return (m && m.userId) || ME; }   // 自己
function peerKey(p){ return (p.user && p.user.userId) || p.id; }           // 别人/席位
LiveHtml.set("vote:" + voteKey(), card);                                   // 写
// 渲染 / 去重时用 peerKey(p)，"我的"席位判定 peerKey(p) === voteKey()
```

注：写操作广播里的 `by` **永远**是服务端校验过的 `userId`（可信归属），与上面展示用的 key 相互独立——别把 `by` 当成连接 id。

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
