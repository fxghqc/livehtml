# livehtml

给 agent 生成的 HTML **同时承担两件事**：
1. **托管 HTML** —— 上传到 MinIO（专用 backend），通过 `/pages/<key>` 访问
2. **多人协作状态** —— 元素加 `data-live="key"`，多个浏览器实时同步

```
agent ──PUT /pages/foo (HTML body)──▶ livehtml ──▶ MinIO (bucket: pages)
                                         │
                                         └──▶ 自动准备 room "pages/foo"

user  ──GET /pages/foo──────────────▶ livehtml ──▶ 从 MinIO 取回 HTML
                                         │
                                         └──▶ sync.js 连 WS，状态自动绑定
```

**单一 identifier**：`foo` 既是 URL path、又是 MinIO key、又是 state room id——结构上不可能漂移。

## 设计取舍

- **场景**：code agent 生成大量临时 HTML 给多人查看/标注，需要内容托管 + 状态共享在一个接入点
- **不是 CRDT**：用 last-write-wins，典型场景是异步标注（A 勾框 B 看到），不是字符级并发编辑
- **agent 不直接操作 MinIO**：所有操作走 livehtml 4 个端点，避免命名漂移、孤儿状态、凭证扩散
- **数据归属在你手里**：HTML 在你的 MinIO，状态在 `state/<room>.json`，Claude 直接 Read 即可
- **zero magic**：livehtml 不修改 HTML 内容，PUT 上去是什么，GET 拿回来就是什么；agent 看到的源码 = 实际运行的内容

## 启动

### Docker（推荐，含 MinIO）

```bash
cp .env.example .env   # 改 MINIO_ROOT_PASSWORD
docker compose up -d
# livehtml     :39191
# minio API     :39192   (mc alias 用)
# minio Console :39193   (web UI)
```

### 本地开发（无 MinIO，/pages 端点 503）

```bash
bun install
bun start              # http://localhost:8787
# 或 bun dev (--hot)
```

带 MinIO 的本地开发：

```bash
MINIO_ENDPOINT=localhost:9000 \
MINIO_ACCESS_KEY=... MINIO_SECRET_KEY=... \
MINIO_BUCKET=pages bun start
```

## 在 HTML 里接入

```html
<!-- 任何带 data-live 的元素会自动绑定到状态 -->
<input type="checkbox" data-live="task-1"> 任务一
<input type="text"     data-live="title">
<textarea              data-live="note"></textarea>
<select                data-live="status">
  <option value="">未开始</option>
  <option value="done">完成</option>
</select>
<input type="number"   data-live="score">
<input type="range"    data-live="progress">
<details               data-live="section-1">...</details>

<!-- 一行接入 -->
<script src="http://localhost:8787/sync.js"></script>
```

## 房间（room）

每个 HTML 的状态隔离在一个 room 里。优先级（从高到低）：

1. `<script src="sync.js" data-room="my-room">`
2. `<meta name="livehtml-room" content="my-room">`
3. `window.LiveHtmlRoom = "my-room"` (在 script 加载前设置)
4. 默认：`location.pathname`

当 HTML 用 `file://` 协议打开时，`location.pathname` 是绝对路径，跨设备不一致。**给跨用户共享的 HTML 显式设置 `data-room`**。

## 服务端注入（`/pages/<key>` 提供的页面）

通过 `/pages/<key>` 提供页面时，服务端会在**发给浏览器的那一刻**改写 HTML（存储里的原始字节不变）：剥掉页面自带的 `<script src=".../sync.js">`，插入自己的一份，带上两个属性：

```html
<script src="/sync.js" data-room="pages/<key>" data-token="<房间凭证>"></script>
```

- 页面 HTML **不必**自己写那行 script；写了也没关系，会被换掉。
- `data-room` 由服务端说了算，页面里手写的 `data-room` 会被覆盖——room 是页面的身份，交给客户端从 `location.pathname` 猜，换个路径就错。
- **房间凭证**只回答"这个连接能进哪个房间"，不含任何身份信息。身份仍然是 localStorage 的 clientId + `/auth/me` 校验的姓名，一个字没变。
- 注入点在 `<head>`，所以 `window.LiveHtml` 在页面自己的脚本之前就绪，顶层直接调不会 ReferenceError。`sync.js` 会把首个 `onChange`/`watchRoom` 回调推迟到 DOM 解析完再触发。
- 用 `file://` 直接打开、或托管在别处的页面不经过这条路径，仍需自己写 script 标签；开着登录门的部署下它们连不上（没有凭证）。

## 页面能读别的页面（只读）

汇总看板这类页面，发布时声明可读哪些房间：

```bash
livehtml put board board.html --read pages/a,pages/b
```

打开页面时服务端自动把这些房间接上，页面里直接订阅：

```js
LiveHtml.watchRoom("pages/a", function (state) { /* pages/a 变了 */ });
```

只读：页面的 `LiveHtml.set` 永远只写自己的房间。没声明的房间一个字都读不到。断线重连自动恢复，不用自己重订阅。被读房间的 `__users` 会原样出现在 state 里（看板通常正需要这些名字）。

> ⚠ 声明可读 = **把那些房间的数据向所有能打开本页的人开放**，哪怕对方本来无权打开那些页面；本页若是 `--public`，那就是向所有能访问服务的人开放。发布时会返回一条 warning 提醒。

## 上行护栏

- 单条消息上限 `OPS_MAX_BYTES`（默认 256KB），在解析之前就拒，返回 `{t:"too_large"}`。
- 写入速率 `OPS_RATE_PER_SEC`（默认 60/秒，按 (房间, 写者) 计，突发 2 倍；`0` 关闭）。超限该条被丢弃并返回 `{t:"throttled", key, retryAfterMs}`，`sync.js` 收到后停发、到点用**当前**值重发那个键——不会用被丢弃的旧值覆盖页面后来写的新值。
- 计数的写者：登录用户按 uid（开几个标签页不涨额度），匿名按连接。**不按页面自称的 clientId**，那是可以随便换的。

## 状态键前缀：`~` 与 `__`

两个前缀是特殊的，且互相正交：

- **`~` = 只活在内存里（live-only）**。像普通 key 一样广播、一样出现在 `init` 和 `GET /state`，但**不落盘**、**不推进版本号**——所以它不产生新 etag，也不会唤醒挂着的 `?wait=` 长轮询。给光标、正在输入提示、高频快照这类"一秒后就没价值"的状态用；用普通 key 装这些，每次写都要触发一次去抖磁盘写和一次 agent 侧的变更唤醒。
  超过 `TRANSIENT_TTL_SEC`（默认 30 秒，`0` = 关闭）没被重写的 `~` key 会被服务端回收，回收以一条 `del` 广播出去，带 `by: ""` + `src: "server"`。按 `~` 该有的频率写的人永远不会被回收，被回收的是写者已经离开的 key。**别拿 `~` 当存储**（"当前页码"这种很久才写一次的值）——那种值本来就该用普通 key。
- **`__` = 服务端保留**（目前只有 `__users`）。浏览器侧写不进去：WS 上的 `set`/`del` 被忽略，`LiveHtml.set` 直接拒绝并告警；HTTP 整体覆盖（`PUT`/`DELETE /state`）会剥掉调用方传的 `__users`、把当前值原样带过去。除此之外就是一个普通的持久化 key。

## 用户身份（presence）

右上角浮动一个小 chip 显示在线人数，点开可看到所有用户并改名。默认随机分配 `User-XXXX`。三种方式自定义：

```html
<meta name="livehtml-user" content='{"name":"范晓","color":"#f97316"}'>
```

```js
window.LiveHtmlUser = { name: "范晓" };  // 在 sync.js 加载前
```

```js
window.LiveHtml.setUser("范晓");  // 运行时改
```

`LiveHtml.peers` 只有**当前在线**的连接。要给已经离开的人显示名字，用 `LiveHtml.users` —— 服务端维护的花名册 `{userId: 姓名}`，记录所有登录过这个房间的人（仅在开了登录门时有内容，匿名访客不入册）：

```js
LiveHtml.onChange(function (state) {
  Object.keys(state).forEach(function (k) {
    if (!k.startsWith("vote:")) return;
    var uid = k.slice(5);
    console.log((LiveHtml.users[uid] || "访客") + " 投了 " + state[k]);
  });
});
```

## HTTP API

### HTML 托管（`/pages`，MinIO 后端）

```bash
# 上传 HTML
curl -X PUT --data-binary @report.html \
  http://host:39191/pages/aura/report-05-22

# 用浏览器打开
open http://host:39191/pages/aura/report-05-22

# 列表
curl http://host:39191/pages/

# 删除（自动清掉对应 state）
curl -X DELETE http://host:39191/pages/aura/report-05-22
```

- key 可以包含 `/` 做层级
- 上传内容会被以 `text/html; charset=utf-8` + `Cache-Control: no-cache` 返回
- agent 不需要直接访问 MinIO；MinIO 凭证只在 livehtml 容器里

### 状态 API

```bash
# 读取房间状态（JSON）
curl http://host:39191/state/pages/aura/report-05-22

# 整体覆盖
curl -X PUT http://host:39191/state/pages/aura/report-05-22 \
  -H 'Content-Type: application/json' -d '{"task-1": true}'

# 清空
curl -X DELETE http://host:39191/state/pages/aura/report-05-22

# 列出所有房间及在线人数
curl http://host:39191/rooms
```

任何 HTTP 写操作都会通过 WebSocket 实时广播给在线客户端。

## 登录与鉴权（可选）

默认 livehtml **不带鉴权**（房间名当作能力凭证）。需要公网/局域网共享但又想限制访问时，
可以打开两道**互相独立、各自用环境变量开关**的门。两道门都关掉 = 行为跟以前完全一样。

> **zero magic 仍然成立**：鉴权全部在 `server.ts` + `public/sync.js` 里完成，
> agent 生成的 HTML 一个字都不用改。
> 设计细节见 `docs/superpowers/specs/2026-05-29-dingtalk-oauth-login-design.md`。

### 1. 钉钉扫码登录门（面向人类访问者）

挡在 `GET /pages/<key>` 的 HTML 与 `/ws` 前面。设置 `DINGTALK_CLIENT_ID` 即开启：
浏览器没有有效会话时，被 302 重定向到钉钉扫码登录；扫码后我们用授权码换 union/userId，
**校验对方是不是本企业成员**，通过后下发一个 HMAC 签名的无状态会话 cookie（`lh_sess`）。
登录后 presence 显示真实姓名，勾选/编辑记录的 `by` 就是可信的钉钉 userId。

```bash
# ---- 人类登录门（留空即关闭）----
DINGTALK_CLIENT_ID=        # 设了它，/pages/* 的人类访问就需要登录
DINGTALK_CLIENT_SECRET=
DINGTALK_CORP_ID=          # 可选，再做一层企业 corpId 软校验
# 用来拼**精确匹配**的 OAuth redirect_uri 的稳定外部地址；
# 必须等于你在钉钉控制台登记的回调地址。留空则回退到请求来源。
LIVEHTML_PUBLIC_BASE_URL=http://192.168.130.12:39191
SESSION_SECRET=           # 开了登录门**必填**，用长随机串
SESSION_TTL_SEC=604800    # 会话有效期，默认 7 天
LIVEHTML_API_TOKEN=       # 可选（CI/应急）：静态共享令牌；agent 推荐用 `livehtml-login` 拿个人 token
```

> **fail-closed**：设了 `DINGTALK_CLIENT_ID` 却没设 `SESSION_SECRET`，server 拒绝启动。
> （不再要求 `LIVEHTML_API_TOKEN`——agent 用 `livehtml-login` 拿个人 token，见下。）

部署侧需要操作（见 spec §15）：

1. 钉钉开发者控制台 → 应用 → **登录与分享**，**逐字**登记回调地址
   `http://192.168.130.12:39191/auth/dingtalk/callback`（协议/host/端口/path 必须精确匹配）。
   **先确认控制台接受 `http://` 回调**——这是头号可行性风险；如果它强制 `https`，
   就用 HTTPS 反代挡在前面，并把 `LIVEHTML_PUBLIC_BASE_URL` 设成那个 origin。
2. 给应用授**通讯录读权限**（`getbyunionid` / `v2/user/get` 需要），否则这两个调用会报错（按 502 处理）。
3. 确保 `livehtml` 容器能**出网**访问 `api.dingtalk.com` 和 `oapi.dingtalk.com`。
4. 所有访问者的桌面浏览器都要能路由到回调 host（局域网内成立）。

### 2. API token 门（面向 agent / 读回接口）

挡在 agent 用的读回接口前面：状态 HTTP API（`/state/*`）与页面上传（`PUT /pages/<key>`）。
设置 `LIVEHTML_API_TOKEN` 即开启静态令牌门。开了钉钉登录门时，agent 接口默认由**个人签名 token**
（`livehtml-login` 获得）保护，所以静态 `LIVEHTML_API_TOKEN` 变成**可选**（CI/应急）。两种凭证都被接受。

### Agent 拿 token：`livehtml-login`（推荐）

开了钉钉登录门后，agent 不用 operator 手发密钥——跑一次：

```bash
bun ~/.claude/skills/livehtml/scripts/livehtml-login.ts    # 脚本随 skill 安装；或用 livehtml-login
```

脚本作为 skill 的一部分随 SKILL.md 一起安装（`<skills>/livehtml/scripts/`）；运行时**自动从
`~/.local/state/livehtml/` 读取 `base-url`（和已有的 `api-token`）**，无需 `--base`。
浏览器扫码登录 → 个人签名 token 自动写入 `~/.local/state/livehtml/api-token`，约月级到期前自动
静默续期。`LIVEHTML_API_TOKEN`（静态共享密钥）仅作 CI/应急可选项。

```bash
# ---- agent 接口 API token 门（留空即关闭）----
LIVEHTML_API_TOKEN=       # 设了它，state/upload 调用需要 Bearer token
```

```bash
# agent 上传页面（带 token）
curl -X PUT -H "Authorization: Bearer $LIVEHTML_API_TOKEN" \
  --data-binary @report.html http://host:39191/pages/aura/report

# 读回状态（带 token）
curl -H "Authorization: Bearer $LIVEHTML_API_TOKEN" \
  http://host:39191/state/pages/aura/report
```

配套 skill 的 installer 会把 token 存到 `~/.local/state/livehtml/api-token`，
agent 调用时自动读取。

### 3. 公开页例外（`X-Public: 1`）

开了钉钉登录门后，默认所有 `/pages/<key>` 都要登录。要让**某一页**免登录（公开看 + 公开协作），
上传时带 `X-Public: 1`，该标记会持久化为 MinIO 对象元数据（`public=1`，元数据是唯一真相来源）：

```bash
# 上传一个公开页（任何人免登录即可访问 + 协作）
curl -X PUT -H "Authorization: Bearer $LIVEHTML_API_TOKEN" -H "X-Public: 1" \
  --data-binary @open.html http://host:39191/pages/open
```

不带该 header（或 `X-Public: 0`）则覆盖为私有页。

## 数据闭环（Claude 读回）

状态以 JSON 落盘在 `state/<room>.json`：

```bash
ls state/
# demo.json  wstest.json  report-2026-05-21.json

cat state/demo.json
# {
#   "task-1": true,
#   "note": "hello"
# }
```

Claude 可以用 Read 工具直接读这些文件，或调 HTTP API 查询。

## WebSocket 协议（如要自定义客户端）

WS 端点：`ws://host:port/ws`，消息全是 JSON。

**Client → Server**

```jsonc
{ "t": "hi",  "room": "demo", "clientId": "uuid", "user": {...}, "token": "<房间凭证>" }
{ "t": "set", "key": "task-1", "v": true }
{ "t": "del", "key": "task-1" }
{ "t": "pres", "v": { "name": "范晓" } }
```

开着钉钉登录门时，`hi` 必须带 `token`（页面 GET 注入的房间凭证，且必须是**这个** room 的），否则回 `{"t":"denied","reason":"room"}` 并断开。升级请求带了合法 API bearer 的连接（agent CLI、自定义客户端）不需要 token。门关着时不校验，行为与以前一致。

**Server → Client**

```jsonc
{ "t": "init", "room": "demo", "state": {...}, "peers": [...], "you": "id" }
{ "t": "set", "key": "...", "v": ..., "by": "peerId" }
{ "t": "del", "key": "...", "by": "peerId" }
{ "t": "del", "key": "~...", "by": "", "src": "server" }  // `~` key 到期被回收
{ "t": "replace", "state": {...}, "by": "..." }  // 整体替换 (来自 HTTP PUT)
{ "t": "pres", "peers": [...] }
{ "t": "room", "room": "pages/a", "msg": {...} }   // --read 声明的只读房间，msg 是该房间的原始帧
{ "t": "throttled", "key": "...", "retryAfterMs": 120 }  // 该条被限流丢弃
{ "t": "too_large", "limit": 262144 }              // 该条超过单条大小上限
{ "t": "denied", "reason": "room" | "login_required" }
```

客户端 `set`/`del` 里 `__` 开头的 key 会被服务端静默忽略（见「状态键前缀」）。回收帧的 `by` 恒为空串——参与者的 `by` 是 clientId 或校验过的 userId，永远非空，所以按作者过滤 `del` 的页面可以靠 `by === "" && src === "server"` 把服务端回收和别人的删除区分开。

## 已知限制

- **Cookie 只对人有效**：开着登录门时，受保护页面的 HTML 和 `/auth/token` 都只服务**浏览器导航**（`Sec-Fetch-Dest: document`/`iframe`，或回落到 `Accept: text/html`）。因为 livehtml 把页面托管在自己的域名下，页面里的 `fetch()` 是同源的、会自动带上访问者的 cookie——不挡这一层，一个页面就能替访问者生成长期 API token、或把别的受保护页面整个读走。带 Bearer 的调用（CLI、curl）和公开页不受影响；用 curl 抓受保护页面的 HTML 要么带 token，要么显式加 `-H "Accept: text/html"`
- **不是 CRDT**：两人同时编辑同一文本字段时，后写覆盖先写。对 checkbox/select/数值这种"原子值"完全 OK；不适合做多人同时编辑长文档
- **文本输入冲突保护**：远端更新到达时，如果当前用户正在 focus 该字段，远端更新会被忽略（避免打断输入）
- **鉴权可选**：默认不带鉴权，房间名足够长/随机就够用；公网/局域网共享可开钉钉登录门 + API token 门（见上方「登录与鉴权」）
- **无 schema**：状态是任意 JSON 对象，agent 决定 key 命名约定

## 文件结构

```
livehtml/
├── server.ts                  # Bun WebSocket + HTTP + MinIO 代理
├── public/sync.js             # 客户端：自动绑定 + presence chip
├── examples/demo.html         # 端到端示例
├── skill/                     # Claude Code skill 源码（跟服务一起版本化）
│   ├── SKILL.md
│   └── evals/evals.json
├── scripts/install-skill.cjs  # npx / 本地 / curl 三用 installer
├── state/                     # 房间 JSON 文件（gitignored）
├── minio-data/                # MinIO 数据卷（gitignored）
├── Dockerfile
├── docker-compose.yml         # livehtml + minio 两个 service
├── .env.example               # MINIO 凭证模板
└── package.json
```

## 安装配套 skill（Claude Code）

skill 源码在 `skill/` 目录里，跟服务一起版本化。SKILL.md 的命令统一用
`$LIVEHTML_BASE_URL` 变量，部署地址存在配置文件
`~/.local/state/livehtml/base-url`（遵循 `XDG_STATE_HOME`），脚本运行时加载：

```bash
export LIVEHTML_BASE_URL=$(cat ~/.local/state/livehtml/base-url)
```

### A. 一行命令（团队最简）

把 `<livehtml-url>` 换成你的部署地址，例如 `http://localhost:39191`。

```bash
# macOS / Linux
curl -fsSL <livehtml-url>/install | sh
```

```powershell
# Windows (PowerShell)
irm <livehtml-url>/install.ps1 | iex
```

脚本由 livehtml server 实时生成（永远跟当前部署一致），会把 SKILL.md 装进
**所有检测到的 agent** 的全局 skills 目录——Claude Code（`~/.claude/skills/`）、
Codex（`~/.codex/skills/`）、Cursor（`~/.cursor/skills/`），一个都没装到则默认装
Claude Code；同时把访问地址写进 `~/.local/state/livehtml/base-url`。完事后重启对应
agent 即可。

> 路径遵循 `skills` 生态约定，并尊重 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
> `XDG_STATE_HOME` 环境变量。

### B. 通过 `npx skills`（开放 skills 生态）

[`skills`](https://github.com/vercel-labs/skills) 是跨 agent 的 skill 管理 CLI。
它从 **git 仓库**装，所以源要指向 GitHub 仓库 `fxghqc/livehtml`，**不是**
`<livehtml-url>`（那只是 server，不是 git 端点）：

```bash
npx skills add fxghqc/livehtml -g -a claude-code -y
# -g 全局安装  -a 指定 agent  -y 非交互；默认 symlink，加 --copy 改成独立拷贝
```

好处是能用 `npx skills list / update / remove` 统一管理。

### C. 通过 npx（仓库自带 installer）

```bash
npx -y github:fxghqc/livehtml livehtml-skill install
```

### D. 本地仓库（开发者）

```bash
git clone git@github.com:fxghqc/livehtml.git && cd livehtml
npm run install-skill              # symlink 模式：源码改 = skill 改
# 或 copy 模式：
node scripts/install-skill.cjs install --force
```

> B / C / D 都从源码安装，**不会**写 `base-url` 配置；装完手动设一次（见上方），
> 或直接用 A 让 server 帮你写。SKILL.md 顶部也有这个提示。手动设：
>
> ```bash
> mkdir -p ~/.local/state/livehtml
> echo '<livehtml-url>' > ~/.local/state/livehtml/base-url
> ```

### 卸载 / 查看

```bash
node scripts/install-skill.cjs uninstall
node scripts/install-skill.cjs status
```

## 路线图（按需扩展）

- [ ] HTTPS / WSS 支持（自签或 Let's Encrypt）
- [x] 鉴权：钉钉扫码登录门（人类）+ API token 门（agent）+ `X-Public` 公开页例外（见「登录与鉴权」）
- [ ] Yjs 通道：给真正需要并发编辑的字段开个 `data-live-yjs`，复用同一个 WebSocket 连接
- [ ] 历史/审计：state 写入时追加到 `state/<room>.log`
- [ ] 房间列表 UI（`/` 着陆页加在线房间表格）
