---
name: livehtml
description: Use livehtml to publish an agent-generated HTML page that has persistent, multi-user state — checkboxes, form fields, notes, ratings, and toggles sync in real-time across everyone who opens the URL, and survive page reloads. Trigger this skill whenever the user wants a shareable interactive HTML report, a team checklist or form, an annotatable document, a poll/feedback page, a milestone tracker, an agent report with markable items, or anything that fits "make a page the team can click/type into and the state sticks". Also trigger for phrasings like "host this HTML", "live HTML", "collaborative HTML", "shareable form", "让大家在网页上勾/填", "做个团队反馈页", "agent 报告加上协作能力". Even if the user just asks to "make an HTML report", if multi-user interaction or persistent state would clearly improve it, prefer livehtml over plain static HTML.
---

# livehtml

A deployed service that **hosts HTML files + provides real-time multi-user state**. One URL gets the team a shared interactive page; any element with `data-live="key"` automatically syncs across browsers.

## 用法：`livehtml` CLI（推荐）

skill 自带一个 `livehtml` CLI（`scripts/livehtml.ts`，需 Bun），**自动从 `~/.local/state/livehtml/` 读取 base-url + token（token 自动续期）**——不用 export 环境变量、不用手动拼 `Authorization` 头。

```bash
livehtml <子命令>            # 装了 bin 时
bun ~/.claude/skills/livehtml/scripts/livehtml.ts <子命令>   # 通用（路径随 agent 而定）
```

| 命令 | 作用 |
|---|---|
| `livehtml login` | 受保护部署登录一次（钉钉扫码，拿/续期个人 token） |
| `livehtml put <key> <file> [--public]` | 上传 HTML 页面 → `…/pages/<key>` 立即可分享（`<file>` 用 `-` 读 stdin） |
| `livehtml get <key>` | 读回该页状态 (JSON) |
| `livehtml set <key> '<json>'` | 整体写入该页状态 |
| `livehtml watch <key>` | 阻塞至下次有人改动（最多 60s，省掉 `sleep` 轮询） |
| `livehtml ls` / `livehtml rm <key>` | 列出 / 删除页面 |
| `livehtml status` | 显示 base-url / 登录状态 |

`<key>` 可含 `/` 做层级（如 `aura/report`）。base-url 由安装器写入 `~/.local/state/livehtml/base-url`；从源码用时可手建该文件，或给任意命令加 `--base http://your-host:port`。

> 下文的 `curl …$LIVEHTML_BASE_URL…` 是**等价的原始 HTTP**（无 Bun、或想看底层时用）；用原始 curl 才需要 `export LIVEHTML_BASE_URL=$(cat ~/.local/state/livehtml/base-url)`，受保护部署再加 `-H "Authorization: Bearer $(cat ~/.local/state/livehtml/api-token)"`。CLI 这些都自动处理。

## When this skill saves the day

- "Make a team checklist where everyone can tick items off"
- "Host this report so the group can mark which findings to follow up on"
- "Build a quick feedback form for tomorrow's lunch menu"
- "A page where each of us picks our preferred time slot"
- "Make this analysis interactive — let people annotate"

## 两步走

1. **写 HTML**：加 `data-live` 属性即可。同步脚本由服务端在提供页面时自动注入，你不用写 `<script src="/sync.js">`（写了也无妨，会被换成服务端那份）。
2. **`livehtml put <key> page.html`** → `…/pages/<key>` 立即可分享。

无构建、无配置、无需碰 MinIO。

## 最小 HTML 模板

加个属性就是全部接入 —— 不用 `<script>`、不用 `<meta>`、不用初始化、不用手填 room id：

```bash
cat > page.html <<'EOF'
<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>your title</title></head>
<body>

  <!-- 任何要同步的元素加 data-live="<唯一key>" -->
  <input type="checkbox" data-live="task-1"> 任务一
  <textarea data-live="notes"></textarea>
</body>
</html>
EOF

livehtml put my/page page.html        # 上传，URL = …/pages/my/page
```

**脚本和 room id 都由服务端注入**：页面经 `/pages/<key>` 提供时，服务端剥掉页面自带的 sync.js 标签、插入自己那份，并把 room id（= `pages/<key>`）和房间凭证写进标签属性。URL = MinIO key = state room，一个标识贯穿，页面里不用出现 base-url，也不要自己写 `data-room`（会被覆盖）。

脚本注入在 `<head>`，所以 `window.LiveHtml` 在你的脚本之前就绪，顶层直接调用是安全的。

> 原始 HTTP 等价：`curl -X PUT --data-binary @page.html $LIVEHTML_BASE_URL/pages/<key>`（受保护部署再加 Bearer 头）。

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

## 首屏默认值：用 `data-default`（重要）

`sync.js` 异步接入：先渲染 HTML，WS 连上后再用服务端状态覆盖所有 `data-live` 元素。把默认值只写在元素里会出两类问题——**首屏闪烁**（默认值被真实值顶替），和**默认值丢失**（服务端无此 key 时元素被清空；contenteditable 尤甚，清空后残留 `<br>`，刷新即用空值覆盖默认文案）。

**首屏敏感字段**（标题 / 铭牌 / 任务名 / 案号 / 说明 / 便签 / `contenteditable` / 隐藏 input —— 任何「空值会破坏首屏」的字段）**别只写裸默认值，加 `data-default`**；checkbox / radio / select 一般不用。sync.js 已内置处理、无需 seed 脚本——state 有非空值就用真实值，缺失 / 空 / `<br>` 则用 `data-default` 并自动写回持久化（反模式：裸 `<span contenteditable data-live="meta:title">默认</span>`，刷新即被清空）：

```html
<span contenteditable data-live="meta:title" data-default="A系列晨检副本">A系列晨检副本</span>
```

**去闪烁（可选）**：给 `<body class="live-pending">` 加 CSS 隐藏首屏字段，sync.js 拿到状态后（或 1.5s 兜底）自动移除该类：

```css
body.live-pending .first-screen-live-fields { visibility: hidden; }
```

**修已部署页面**：`livehtml get <key>` 看是否已被清空，再**先 get、合并、再 set**写回默认（别覆盖用户已有数据）：`livehtml set <key> '{"meta:title":"A系列晨检副本"}'`。

## Read back state (agent-side)

Once a page is live, its state is plain JSON. Read it back to see what users
have done, aggregate across pages, or feed results into the next agent step.
The canonical endpoint is `/pages/<key>/state` — same identifier as the page
URL. The legacy `/state/pages/<key>` is byte-for-byte equivalent and still
works.

All three cookbooks use `-A "livehtml-agent-readback/1"` so the server access
log can distinguish agent read-backs from browser traffic. Keep it.

> 简单做法：用 CLI —— `livehtml get <key>`（读回）、`livehtml watch <key>`（长轮询），自动带凭证。
> 下面的 `curl` 是等价原始 HTTP；受保护部署用 curl 时才要先 `livehtml login`，并加
> `-H "Authorization: Bearer $(cat ~/.local/state/livehtml/api-token)"`。未开门的部署都不需要。

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

> **整页主体设计（布局 / 排版 / 配色 / 风格）也值得做好。** 这块 livehtml 暂未内置专门指引——可以借鉴现成 skill（**装了就顺手用，没装也别强求**，直接写好 HTML 即可）：[`frontend-design`](https://github.com/anthropics/skills/tree/main/skills/frontend-design)（创意方向）、[`web-design-guidelines`](https://github.com/vercel-labs/agent-skills)（Vercel，无障碍 / 正确性）。下面三节（可视化 / 3D / 动画）是**可选·进阶**的内容工具——基础页面（`data-live` + 一行 `<script>`）一概不需要。

## 可视化（可选·进阶）：图表 / 表格 / 关系图

数据多的页面，单文件里直接 CDN 引库即可，**无需构建**。图表元素照常可加 `data-live`（如多人同步「当前视图/筛选」）。下面的库均已核实活跃维护。

**首选：能直接用 SVG / Canvas 画，就直接画。** 自定义图示、流程/架构图、简单的条/线/进度、徽标式小图，手写 inline `<svg>`（或 canvas）通常比上库更好看、更可控、零依赖 —— 配色、排版、留白都由你精确掌控。只有当数据量大、需要标准交互、或是成套统计图时，才上下面的库。

想要**生成式 / 粒子 / 自定义交互 / 动态 canvas** 图形（比手写 canvas 省力）：[p5.js](https://github.com/processing/p5.js)（创意编程，最易上手）· [konva](https://github.com/konvajs/konva)（可交互 2D canvas，拖拽图元/自定义编辑器）· [Pixi.js](https://github.com/pixijs/pixijs)（2D WebGL，海量元素/高性能）· [Rough.js](https://github.com/rough-stuff/rough)（手绘风，稳定但维护放缓）· [two.js](https://github.com/jonobr1/two.js)。深度生成艺术装了 `algorithmic-art` skill 就用，没有也能直接写 p5.js。

- **通用图表**：[Chart.js](https://github.com/chartjs/Chart.js)（**首选**，简洁好看，canvas）· [ECharts](https://github.com/apache/echarts)（最全，复杂场景）· [Plotly.js](https://github.com/plotly/plotly.js)（科学/统计/3D）· [ApexCharts](https://github.com/apexcharts/apexcharts.js)（交互漂亮）· [charts.css](https://github.com/ChartsCSS/charts.css)（纯 CSS，零 JS，最适合简单条/线）
- **声明式（数据分析图，agent 写 JSON 即可）**：[Vega-Lite](https://github.com/vega/vega-lite)
- **时序**：[uPlot](https://github.com/leeoniya/uPlot)（小而快）· [lightweight-charts](https://github.com/tradingview/lightweight-charts)（金融）
- **表格 / 数据网格**：[Grid.js](https://github.com/grid-js/gridjs)（简单，排序/搜索/分页）· [RevoGrid](https://github.com/revolist/revogrid)（高性能可编辑，Excel 模式）· [Jspreadsheet CE](https://github.com/jspreadsheet/ce) · [AntV S2](https://github.com/antvis/S2)（透视表）
- **关系图 / 流程 / 网络**：静态/自定义流程图、架构图**优先直接画 SVG**（最好看、最可控）；要自动布局或可交互的大图再上 [AntV G6](https://github.com/antvis/G6) / [X6](https://github.com/antvis/X6) · [Cytoscape.js](https://github.com/cytoscape/cytoscape.js) · [3d-force-graph](https://github.com/vasturiano/3d-force-graph)。（Mermaid 能用文本快速出图，但样式一般、不够精致，**别作首选**；GoJS 强但**商业授权**。）
- **甘特 / 时间线**：[Frappe Gantt](https://github.com/frappe/gantt) · [vis-timeline](https://github.com/visjs/vis-timeline)
- **大 / 流数据**：[Perspective](https://github.com/perspective-dev/perspective)（web-component，高性能）

一句话：自定义图示 / 流程 / 架构图 → **手写 SVG**；成套数据图 → Chart.js / ECharts；大数据分析 → Vega-Lite / Perspective。

## 3D（可选·进阶）

需要 3D 时，单文件优先选「声明式 / 一个标签」的（均已核实活跃）：
- **[model-viewer](https://github.com/google/model-viewer)** —— ⭐ 一个 `<model-viewer src="x.glb">` 标签即可展示 glTF 模型，最省事。
- **[A-Frame](https://github.com/aframevr/aframe)** —— 用 HTML 标签（`<a-scene>`）写 3D/VR 场景，声明式、agent 友好。
- **[Three.js](https://github.com/mrdoob/three.js)** —— 事实标准，完全控制（112k★）；[Babylon.js](https://github.com/BabylonJS/Babylon.js) / [PlayCanvas](https://github.com/playcanvas/engine) 为更完整的引擎。
- **[deck.gl](https://github.com/visgl/deck.gl)** —— 地理 / 大数据 WebGL 图层（地图上叠加海量数据）。

3D 较重、对单文件报告页是少数场景，确有需要再上。

## 动画（可选·进阶）

单文件 CDN 即可，**能用 CSS 就别上库** —— 一次编排好的入场动画（staggered `animation-delay`）纯 CSS 就够。需要 JS 时（均已核实活跃）：

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

- **Agent 一次性登录**：`livehtml login`（即 `bun ~/.claude/skills/livehtml/scripts/livehtml.ts login`，路径随 agent 而定）。
  浏览器扫码登录钉钉 → 个人 API token 自动写入 `~/.local/state/livehtml/api-token`（自动续期，约月级才再扫一次）。
  **之后所有 `livehtml` 命令自动带 token，无需手动加 header**。未启用登录/令牌的部署连这步都不用（向后兼容）。
  （只有用原始 `curl` 时才需手动加 `-H "Authorization: Bearer $(cat ~/.local/state/livehtml/api-token)"`。）
- **公开某个页面**（免登浏览）：上传时加 `--public` —— `livehtml put <key> page.html --public`。
  默认（不加）页面为受保护，需钉钉登录后才能查看。
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

**显示已经离线的人的名字**：`LiveHtml.peers` 只有当前在线的连接，一个人关掉标签页就从里面消失，汇总时拿不到姓名。用 `LiveHtml.users` —— 服务端维护的花名册 `{userId: 姓名}`，含所有登录过这个房间的人（仅登录门开启时有内容，匿名访客不入册）。计票只数自己前缀的键，姓名从花名册取：

```js
LiveHtml.onChange(function (state) {
  var who = [];
  Object.keys(state).forEach(function (k) {
    if (!k.startsWith("vote:")) return;
    who.push((LiveHtml.users[k.slice(5)] || "访客") + "→" + state[k]);
  });
  document.getElementById("who").textContent = who.join("、");
});
```

## 发布被拒绝了怎么办

`livehtml put` 发布前，服务端会静态检查一遍 HTML。**确定会坏**的写法直接拒绝（HTTP 400），并把原因作为数据返回——读 `errors`、改完重发即可，不用问人：

- `data-live` 挂在包着别的元素的容器上（`<div data-live="x"><input></div>`）——会用 textContent 同步、把容器里的内容清空。改成挂在里面的控件本身。
- 页面 JS 调了不存在的成员（`LiveHtml.watch`、`LiveHtml.emit` 之类）——运行时抛错会让整个 `<script>` 停摆。
- `LiveHtml.state(...)` 当函数调——它是属性，直接读 `LiveHtml.state` 或用 `LiveHtml.getState()`。

`warnings` 不拦发布。确信检查判错了，`livehtml put ... --no-lint` 跳过。

`LiveHtml` 的全部成员：`state` / `peers` / `users` / `room` / `me` / `onChange(fn)` / `onStateChange` / `subscribe` / `getState()` / `setUser(名字)` / `set(键,值)` / `del(键)` / `watchRoom(房间,fn)`。

## 汇总看板（可选·进阶）：读别的页面的数据

默认一个页面只能读写自己的数据。要做跨页汇总，发布时声明可读哪些房间：

```bash
livehtml put board board.html --read pages/team-a,pages/team-b
```

页面里订阅（只读，写不进去）：

```js
LiveHtml.watchRoom("pages/team-a", function (state) {
  document.getElementById("a-done").textContent =
    Object.values(state).filter(Boolean).length;
});
```

断线重连自动恢复，不用自己重订阅。被读房间的花名册也在里面（`state.__users`）。

> 注意：声明可读 = 把那些房间的数据**向所有能打开这个看板的人开放**，哪怕他们本来打不开那些页面。看板若是 `--public`，那就是对所有能访问服务的人开放。

## 高频状态（可选·进阶）：`~` 前缀

光标位置、"正在输入"、每秒几十次的快照——这类**一秒后就没价值**的状态，键名前面加 `~`：

```js
LiveHtml.set("~cursor:" + LiveHtml.me.id, { x: 12, y: 40 });
```

`~` 键照常广播给所有人、照常出现在 `LiveHtml.state` 里，但**不落盘、不推进版本号**——它不会把每次移动都写一遍磁盘，也不会把 agent 侧的 `?wait=` 长轮询（Cookbook 4）反复叫醒。代价两条：

- **不持久**。刷新/重启后就没了；`data-live` 绑在 `~` 键上的元素回落到 `data-default`。
- **会被回收**。超过 30 秒（部署可配）没重写的 `~` 键，服务端删掉并广播一条 `del`（`by: ""`、`src: "server"`）。按 `~` 该有的频率写就永远不会被回收，被回收的是写者已经离开的键。

所以**别拿 `~` 当存储**：「当前页码」「选中的 tab」这种很久才写一次的值用普通键；写多频繁都无所谓的值才用 `~`。

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

- **Don't hand-write `data-room`**. The server injects the room id when it serves the page; a hard-coded one is overwritten. Same for the sync.js `<script>` tag — write it or don't, the server replaces it either way.
- **Don't write directly to the MinIO backend**. The whole point of `PUT /pages/` is that one identifier covers HTML + state + URL. Bypassing it splits naming and causes orphan state.
- **Don't use livehtml for true concurrent text editing**. The sync is last-write-wins, not CRDT. Two users typing simultaneously in the same `<textarea>` will overwrite each other character-by-character. Fine for "one person edits at a time" or "occasional updates"; not fine for Google-Docs-style collaboration. For that, use Yjs.
- **Don't pick a random `data-live` key per render**. The key is the persistence identity. If you regenerate HTML with new keys, the old state becomes unreachable.
- **Don't try to nest `data-live` containers**. Each attribute should be on a leaf interactive element. A `<div data-live="x">` containing other `data-live` elements gives unpredictable results.
- **Don't put secrets in `data-live` values**. State is readable by anyone who can open the page.
- **Don't write more than ~60 times a second** from one page. Past that the server drops the extra writes and tells sync.js to back off (nothing is lost, it just lands later). A single write also caps at 256KB — don't stuff an image into one key.

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
