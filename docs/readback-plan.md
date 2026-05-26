# Readback 闭环：A + B + C roadmap

Agent 端读回 state 的迭代方案。来源：2026-05-26 与 codex 两轮讨论收敛结果。

核心 framing（codex）：

> 最大风险不是技术选型，而是把"agent 读回状态"做成一个漂亮但 agent 仍然不用的功能。

---

## A — Read-back 一等公民化

### Scope

- skill 加 "Read back state" 三个 cookbook：单页 / 跨页汇总 / debug
- `GET /pages/<key>/state` 别名（同 PUT/DELETE），与旧 `/state/pages/<key>` 完全等价
- cookbook 里 curl 加 `-A "livehtml-agent-readback/1"`，access log 能识别 agent 调用

### Validation

V1 unit：别名响应 == 旧路径（字节级 diff）

V2 paired trial（sequential，不必 20×2）：
- 先各跑 **6 次**，若 `new ≥5/6 且 old ≤1/6` 立刻停
- 不清就扩到 10
- 只有 stakeholder 要严谨量化才上 20
- 用户填写**用脚本写 ground truth**，不让 agent 自己模拟
- 评分二元化：①是否主动 read-back ②输出 vs ground truth 字段级 diff ③是否基于读回 state 继续下一步

### PR checklist

- [ ] skill 三个 read-back cookbook
- [ ] `/pages/<key>/state` GET/PUT/DELETE 别名
- [ ] 别名等价性测试

---

## B — Long-poll

### 协议

```
GET /pages/<key>/state?wait=<sec>&since=<etag>

→ 200 + JSON，三态：
   { status: "changed",      etag: "<bootId>:<version>", version, state }
   { status: "not_modified", etag: "<bootId>:<version>", version }
   { status: "reset",        etag: "<bootId>:0",         version: 0, state }
```

### bootId 设计

- 启动时 `crypto.randomUUID()`，**仅内存**
- client 传的 `since` 里 bootId 不匹配（重启了）或 version 超前 → 返回 `reset`
- 不持久化 version，也不会把重启前后的 0 混淆
- 内部仍是 monotonic int，外部 since/etag 是 opaque token

### 实现要点

- per-room version 单调递增（PUT/DELETE 都 bump）
- per-room write queue：解决并发 + 原子写（tmp file → rename）
- pending waiter 清理：abort/timeout 必须释放 promise/timer/listener

### Validation

- V1：A `wait=10` poll，B PUT，A <1s 收 `changed` + 新 etag
- V2：`wait=2` 无变化，~2s 返回 `not_modified`
- V3：100 并发 long-poll 60s，内存/句柄稳定
- V4 orchestrator 控制：watcher ready → writer 三次 PUT (1s/3s/5s) → 断言三次 `changed` + version 单调递增；不靠 agent 自由时序
- V5：重启后老 client 旧 etag → 返回 `reset`
- V6：模拟 SIGKILL during write，state 文件不留坏 JSON

### PR checklist

- [ ] `wait/since` long-poll
- [ ] `changed/not_modified/reset` 三态
- [ ] pending waiter abort+timeout 清理测试
- [ ] 重启 reset 行为测试
- [ ] state 原子写（per-room queue + tmp→rename）

---

## C — 元数据 envelope（降级 scope）

### Scope（缩小）

只做磁盘 envelope：

```json
{
  "version": 2,
  "fields": {
    "task-1": { "v": true, "ts": "2026-05-26T10:12:30.123Z", "by": "user-1" }
  }
}
```

- API 默认仍扁平返回（不破老 client）
- `?meta=1` 暴露完整
- **暂缓 agent-facing 字段级 metadata 使用**，等真有 recency/provenance 需求再做

### 关键 risk

老 state 文件混读需要 envelope 顶层 `version` 字段做格式探测，**不要靠 shape 猜**——用户值就可能恰好是 `{v, ts}` 结构。

---

## Shipped 后的持续观测

### 闭环率（leading indicator）

```
readback_close_rate_10m =
  PUT_pages_followed_by_same_key_GET_state_within_10min / PUT_pages
```

- 不预设绝对阈值，先建基线
- <20% → skill 没起作用
- &gt;50% → 形成"生成 → 用户填 → 读回"闭环

不用总 GET 比例（long-poll + debug 会污染）。

---

## 整个 roadmap 都不做（除非触发）

明确排除——不在 A、不在 B、也不在 C 里。codex 拎出来避免 scope 失控。

| 项 | 触发后才做 |
|---|---|
| 多实例 Redis（version 外置 pubsub） | CPU >70% 或要做 HA |
| `by` 身份认证 | livehtml 暴露公网或外部团队用 |
| 大 state 分页 / projection | 监控 P95 state >50 KB |
| reconnect 风暴 jitter | 实际观察到脉冲流量打挂 server |

补偿措施（不做也要交代清楚）：

- `by` 在 SKILL.md 写明 "label only, not authenticated identity"
- 大 state 在 README 写"设计上限 ~100 KB，超过应拆 page"
- reconnect jitter 在 B cookbook 默认就写 `sleep $((RANDOM % 3))`，client 侧解决

---

## A+B 范围内必做的 top 3 风险（codex round 2 排序）

不做立刻咬人：

1. **pending long-poll 清理** —— 不做直接泄漏 connection/promise/timer
2. **server 重启 reset 语义** —— B 协议核心，没它 agent 循环部署后状态错乱
3. **state 文件原子写** —— 半写/并发覆盖会让 state 损坏；per-room write queue 顺手解决并发写同 key

并发写同 key 语义并入 #3 处理。`by` 不可信、大 state、reconnect jitter 都明确延后。
