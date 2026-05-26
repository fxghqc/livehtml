# Spec Restatement —— readback A/B/C 预飞行

读完 plan + server.ts + public/sync.js + skill/SKILL.md + examples/demo.html 后的复述。
任何与 `docs/readback-plan.md` 不一致之处以 plan 为准。

---

## 工作目录 / 环境快照

- `cwd = /Users/fx/Projects/livehtml/`
- **非 git 仓库**（无 `.git`，虽有 `.gitignore`）—— 见 `PROPOSAL-no-git-repo.md`
- 本地默认 `PORT=8787`（`server.ts:7`）；线上是 `192.168.130.12:39191`，**禁止触碰**
- MinIO 通过 env 配置，未配则 `/pages*` 返回 503；A 的 `/state` 别名走的是 `/state/...` 路径，不依赖 MinIO；B 的 long-poll 也不依赖 MinIO；C 的 envelope 是 `state/*.json` 磁盘格式，同样不依赖 MinIO
- 测试都跑 `127.0.0.1:<random-port>`，每个 V 脚本自己 spawn server，互不打架
- 没有 `tests/` 目录，需新建

---

## 必须保持的 invariants（违反 = 退化）

1. `/pages/<key>` GET/PUT/DELETE 行为不变（HTML 上传/取回/删除 + 删除时清 room state + 广播 replace）
2. `/state/<room>` GET/PUT/DELETE 行为不变（包含 `sanitizeRoom` 现有规则）
3. WebSocket 协议不变：`hi/init/set/del/replace/pres` 五种消息，字段名/语义保持
4. `examples/demo.html` 在浏览器里勾 checkbox / 改 textarea / toggle details / 改 select / 拖 range：
   - DOM 改动 → state 落盘 `state/demo.json`
   - 多窗口同步立刻可见
   - 重新打开窗口 state 恢复
5. `sanitizePageKey` / `sanitizeRoom` 规则不动；新增端点必须复用这两个函数
6. `state/` 落盘格式：A 阶段不动；C 阶段切换到 envelope，但 API 默认仍扁平
7. SKILL.md 现有 cookbook（state 读取走 `/state/pages/<key>`）描述的行为持续可用；A 加新别名不替换旧路径
8. **server.ts:50/94-105 已实现 per-room write chain + 原子写**（tmp → rename）—— B 的 PR checklist 中这一条退化为"验证已存在 + 加测试"，不重写

## 必须新增 / 必须改的（按 plan）

### A —— Read-back 一等公民化

- **skill 三个 cookbook**：单页 / 跨页汇总 / debug —— 在 `skill/SKILL.md` 现有 "Read state from outside the browser" 段落基础上扩展
- **`/pages/<key>/state` 别名**：实现成 GET/PUT/DELETE，与现 `/state/pages/<key>` 字节级等价
  - 实现路径：`server.ts` 在 `path.startsWith("/pages/")` 分支里先匹配 `/pages/<key>/state` 子路径
  - 内部转发：`sanitizePageKey(key)` → `sanitizeRoom("pages/" + cleanKey)` → 调原 `/state/<room>` 逻辑
- **cookbook 默认带 `-A "livehtml-agent-readback/1"`** —— 便于 access log 区分 agent 读回

### B —— Long-poll

- **新协议**：`GET /pages/<key>/state?wait=<sec>&since=<bootId:version>`
  - 三态：`changed` / `not_modified` / `reset`
  - 全部 HTTP 200 + JSON body
- **bootId**：进程启动时 `crypto.randomUUID()`，仅内存
- **per-room version**：单调 int，PUT/DELETE 都 bump（HTTP + WS 共 4 处 + `/pages` DELETE 1 处 = 5 处）
- **pending waiter 表**：`Map<room, Set<Waiter>>`；每个 waiter 持有 `resolve` + `timer` + `since`；写入 / 超时 / 客户端 abort 都必须释放 timer 并从 set 摘除
- **保留 `/state/<room>`** 原协议（不带 wait/since 时行为完全等价，长池 ?wait 也加到 `/state/<room>` 上以保持对称 —— 待 spec 重读确认是否要给 `/state/<room>` 也加 long-poll；plan 只要求 `/pages/<key>/state`，**默认只在新别名上加**，避免污染旧路径）

### C —— 元数据 envelope（缩小 scope）

- 磁盘 `state/<room>.json` 切换到 `{version, fields: {key: {v, ts, by}}}` envelope
- API 默认仍扁平 → 兼容旧 sync.js
- `?meta=1` 暴露完整 envelope
- 顶层 `version` 字段做格式探测（不要按 shape 猜 —— 用户值可能恰好长得像 `{v, ts}`）
- **每次 commit / 退出前**：用 `examples/demo.html` 跑一次浏览器回归

---

## 灰区（plan 没明说，需澄清或拍板）

| # | 项 | 当前判断（如未阻塞会走的方向） | 是否阻塞 |
|---|---|---|---|
| 1 | git 仓库不存在，护栏依赖 git | 见 `PROPOSAL-no-git-repo.md` | **是，STOP** |
| 2 | demo.html 的 room 是 `demo` 不是 `pages/demo` | 不强迫它走 pages 路径，沿用现状，回归只验"浏览器同步本身不破" | 否 |
| 3 | `/pages/<key>/state` 是否对 `/pages/<key>` 自身 GET（返回 HTML）有副作用 | 实现上先匹配 `/state` 后缀分支再 fall through，互不影响 | 否 |
| 4 | `/state/<room>` 是否也加 `?wait/since` | plan 只要求 `/pages/<key>/state`，不动旧路径 | 否 |
| 5 | bootId 算法 | `crypto.randomUUID()`（Bun 原生，无新依赖） | 否 |
| 6 | version 计数器是否 per-room 独立 | 是；`versionByRoom: Map<string, number>` | 否 |
| 7 | waiter 超时返回 `not_modified` 还是 `idle` 状态 | plan 写 `not_modified`，照做 | 否 |
| 8 | C 阶段是否保留旧磁盘格式的 backward read | 顶层无 `version` 字段 = 旧格式，读时即时升格（不写回，下一次写入时自然变成新格式） | 否（C 阶段再细化） |
| 9 | demo 浏览器回归是否要自动化（puppeteer 等） | 第一轮手工：启 server → 开浏览器 → 勾几个 → curl /state 验 + 多窗口验。引入 puppeteer 需 PROPOSAL | 否（暂不引入） |
| 10 | 测试用的临时 MinIO | A/B 不需要 MinIO；只有 `/pages/<key>` HTML 上传/取回测试才需要，A+B 不测这部分 | 否 |

---

## 测试脚本清单（`tests/` 下）

每个脚本可独立执行，自启 server 或假设 `livehtml-test-server.sh` 已起。
退出码 0 = pass，非 0 = fail。无人工"看着对"。

### A

- `tests/v1_state_alias.sh` —— PUT 一份 state 到 `/state/pages/<k>`，分别从两个路径 GET，`diff` 字节级相等；DELETE 走新路径也清掉
- `tests/v2_paired_trial.md` —— **不是脚本**，是 paired trial 协议文档（subagent 跑 6×2，人工判定 + 脚本辅助 grep access log）
- `tests/v_demo_smoke.md` —— demo.html 浏览器回归 checklist（手工 5 步），每阶段结束跑一次，记录到 progress

### B

- `tests/v1_longpoll_changed.sh` —— A `wait=10 since=<current>` 后台 poll；B 同步 PUT；断言 A 在 < 1s 收到 `changed` + 新 etag
- `tests/v2_longpoll_not_modified.sh` —— `wait=2`，无 PUT，断言 ~2s（±0.5s）返回 `not_modified`
- `tests/v3_longpoll_concurrency.sh` —— 100 个并发 long-poll 60s；测试结束时 server 内存增量 < 50MB、句柄数稳定
- `tests/v4_longpoll_sequence.sh` —— orchestrator：起 watcher → ready 后 writer 在 1s/3s/5s 各 PUT 一次 → 断言 watcher 收到 3 次 `changed` 且 version 单调递增
- `tests/v5_longpoll_reset.sh` —— 启 server A，PUT 几次拿到 `since=boot1:5` → kill server → 启 server B（新 bootId）→ 老 client 拿 `since=boot1:5` GET → 断言返回 `reset` + version=0
- `tests/v6_atomic_write_kill.sh` —— spawn server，并发 50 个 PUT，中途 SIGKILL；重启后断言 `state/*.json` 全部能 `JSON.parse`（无半写）

### C

C 启动前再列。

### 共用工具

- `tests/_lib.sh` —— start/stop server helper、随机端口、wait_for_port、cleanup trap
- 不引入新依赖；只用 `curl` + `bash` + `jq`（mac/linux 默认或 brew 已装；若 CI 无 jq 走 `python3 -c "import json"` fallback）

---

## 进度与产出

- 每个 commit 后更新 `docs/readback-progress.md`：phase / step / checklist 勾选 / V 脚本最近退出码 + 时间戳 / blocker
- A/B 各结束写 `docs/phase-{A,B}-complete.md` 然后 STOP
- 最终全 pass 写 "ALL DONE"

---

## 即刻 STOP 项

见 `docs/PROPOSAL-no-git-repo.md` —— git 仓库不存在让"出问题回退"和"留分支 review"两条护栏失效。等用户拍板后才继续。
