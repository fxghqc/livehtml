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
{ "t": "hi",  "room": "demo", "clientId": "uuid", "user": {...} }
{ "t": "set", "key": "task-1", "v": true }
{ "t": "del", "key": "task-1" }
{ "t": "pres", "v": { "name": "范晓" } }
```

**Server → Client**

```jsonc
{ "t": "init", "room": "demo", "state": {...}, "peers": [...], "you": "id" }
{ "t": "set", "key": "...", "v": ..., "by": "peerId" }
{ "t": "del", "key": "...", "by": "peerId" }
{ "t": "replace", "state": {...}, "by": "..." }  // 整体替换 (来自 HTTP PUT)
{ "t": "pres", "peers": [...] }
```

## 已知限制

- **不是 CRDT**：两人同时编辑同一文本字段时，后写覆盖先写。对 checkbox/select/数值这种"原子值"完全 OK；不适合做多人同时编辑长文档
- **文本输入冲突保护**：远端更新到达时，如果当前用户正在 focus 该字段，远端更新会被忽略（避免打断输入）
- **无认证**：房间名足够长/随机就够用；公网部署需要自己加鉴权
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

skill 源码在 `skill/` 目录里，跟服务一起版本化。三种装法都把它放进 `~/.claude/skills/livehtml/`：

### A. 一行命令（团队最简）

```bash
curl -fsSL http://192.168.130.12:39191/install | sh
```

下载脚本由 livehtml server 实时生成，永远跟当前部署版本一致。完事后重启 Claude Code（或新开会话）即可。

### B. 通过 npx

```bash
# 从 GitHub 直拉（无需 publish）：
npx -y github:<your-user>/livehtml livehtml-skill install

# 或 npm 发布后：
npx livehtml-skill install
```

### C. 本地仓库（开发者）

```bash
git clone <repo> && cd livehtml
npm run install-skill              # symlink 模式：源码改 = skill 改
# 或 copy 模式：
node scripts/install-skill.cjs install --force
```

### 卸载 / 查看

```bash
node scripts/install-skill.cjs uninstall
node scripts/install-skill.cjs status
```

## 路线图（按需扩展）

- [ ] HTTPS / WSS 支持（自签或 Let's Encrypt）
- [ ] 简单 token 鉴权（房间名 + 密钥）
- [ ] Yjs 通道：给真正需要并发编辑的字段开个 `data-live-yjs`，复用同一个 WebSocket 连接
- [ ] 历史/审计：state 写入时追加到 `state/<room>.log`
- [ ] 房间列表 UI（`/` 着陆页加在线房间表格）
